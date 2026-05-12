# Cezar — Refactor Plan: Agent Cockpit + Skill-Driven Pipelines

**Date:** 2026-05-11 (rev. 2 — design decisions resolved)
**Status:** Plan / proposal — not yet implemented.
**Supersedes:** the "Skill Runner" sketch in `docs/audit/00-AUDIT-REPORT.md` / `01-PHASE-0-PLAN.md`.

---

## 1. The new direction

Cezar becomes a **multi-tenant team SaaS for running AI coding agents on GitHub issues**, with one central cockpit.

1. **Cockpit** — one list of every agent run (queued / running / paused / failed / finished) across all repos in a workspace, with row-level controls (pause, resume, cancel, retry, re-run from a step) and a live step-by-step view of any run.
2. **Agents on issues** — you can manually launch a workflow on an issue, and **incoming issues are auto-triaged**: a triage workflow classifies the issue and decides what should happen with it; if it concludes "this needs a code fix" and autofix is enabled in workspace settings, an autofix workflow is queued automatically. (Conservative defaults: triage is on, autofix is off until explicitly opted in.)
3. **Skill-driven, multi-step pipelines** — autofix is no longer a hardcoded loop. It is a sequence of discrete **steps** — *verify-in-repo → root-cause analysis → fix → review → (fix ↔ review loop) → open PR*. Each step is bound (in the web GUI) to a **skill** (discovered from the target repo), an **agent backend**, and a **model**. Each step posts/updates a comment so the issue and PR always show progress.
4. **Skill auto-discovery** — Cezar reads `.ai/skills/**/*.md` from the connected repo (directory configurable per repo; built-in default skills fill any step that has no repo skill — an empty `.ai/skills/` is fully supported). Skills are the repo's own Markdown skill files — no Cezar-specific schema required.
5. **Multiple agent backends** behind a single `AgentRunner` interface:
   - **Anthropic API** (today's `@anthropic-ai/claude-agent-sdk` path) — for managed cloud runners.
   - **Claude Code CLI** (`claude -p` headless) — the team's Pro/Max subscription, no per-token API billing.
   - **Codex CLI** (`codex exec`) — the team's ChatGPT subscription.
6. **Execution model** — both a **managed cloud runner** (Cezar's own worker containers, default, API-key auth) and an **optional self-hosted runner** a team installs on their own infra (so the subscription CLIs run under the team's own login, and code/tokens never leave the team's machine). The SaaS is the control plane; runners pull jobs and stream events back.

### Decisions driving this plan

| Question | Decision |
|---|---|
| Deployment model | Multi-tenant team SaaS |
| Where agents execute | **Both** a managed cloud runner and an optional self-hosted runner per workspace |
| Backend rollout | All three (API · Claude Code CLI · Codex CLI) behind one `AgentRunner` before the public cockpit launch — with a Codex escape hatch (§7) |
| Skills vs. workflow config | Skills are **auto-discovered from the repo**; the **GUI** maps skill + backend + model + tools onto each pipeline step and triage action, per workspace; skills *augment* a step's prompt, never replace it |
| Skill location | `.ai/skills/` in the connected repo (configurable; supersedes the dead `config.skillsDir` default) |
| Backend auth | Cloud runner = API keys (per workspace). Subscription CLIs = the team's self-hosted runner under their own login |
| GitHub access | Migrate to a **GitHub App**: installation tokens for repo ops + webhooks; user OAuth for login only |

---

## 2. Do we still need Supabase? — Analysis

**Verdict: keep Supabase, but collapse the cron sprawl into a proper job/run model.** Replacing it would be a net loss; restructuring how we use it is a net *reduction* in moving parts.

### Why keep it
For a multi-tenant team SaaS, Supabase is doing real, load-bearing work we'd otherwise rebuild:
- **Auth (login)** — `lib/auth.ts`, `auth/callback/route.ts`. (Repo *operations* move to a GitHub App; Supabase auth stays for "who are you".)
- **Row-level security multi-tenancy** — every table scoped by `workspace_id` with member/admin/viewer policies. The cockpit needs the same isolation.
- **Realtime** — the live cockpit streams agent events to the browser; Supabase Realtime broadcast already powers `cockpit-shell.tsx` and the new cockpit extends it.
- **Hosted Postgres** — issues, runs, events, queue, bindings all fit a relational model; `SELECT … FOR UPDATE SKIP LOCKED` gives us a queue without new infra.

### What changes about how we use it
The pain isn't Supabase — it's the issue/CI autofix loop being **6 stateless Vercel cron handlers** (`issue-sync`, `issue-match`, `issue-fix`, `ci-watch`, `ci-attribute`, `ci-fix`) mutating status flags on `issue_autofix_candidates` / `ci_*` tables with no transactional guard, no retry/backoff, no "stalled" view. Restructure to:
- **One job/run schema** — `jobs` (the queue), `agent_runs` (one row per step execution = the cockpit's backing rows), `agent_run_events` (the streamed events), `runners` (managed + self-hosted, heartbeat + capabilities), `workflow_bindings` + `workspace_settings` (the GUI mapping/toggles). `flows`/`ci_*`/`issue_autofix_candidates` migrate into these (kept as views for one release).
- **One dispatcher + the runners self-claiming jobs** instead of 6 crons. Triage and CI follow-up become *jobs*, not bespoke endpoints. This **deletes** code.
- **Webhook receiver** (thin Vercel route) + a ~15-min reconcile poll replace `issue-sync`/`issue-match`/`ci-watch`.
- **Self-hosted runner needs no Supabase of its own** — it talks to the SaaS over a scoped HTTPS API (claim job, stream events, heartbeat). The SaaS writes Supabase and broadcasts.

### Local JSON store
`packages/core` keeps the file-backed `IssueStore` (CLI) alongside `IssueStore.fromPort(SupabaseStoreAdapter)` (GUI). Decision: **keep the file store as a "solo / local mode" only**; Supabase is canonical for the SaaS. Refactor so GUI = `core + SupabaseStoreAdapter`, CLI = `core + FileStoreAdapter`, both over the same `StorePort`; new state (bindings, runs) gets a file-backed equivalent under `.cezar/` so the CLI path doesn't bit-rot. No feature-parity investment beyond "the local autofix flow still works".

**Bottom line:** Supabase stays and genuinely *helps*. The simplification is collapsing 6 crons + scattered status tables into one queue/run schema with one dispatcher.

---

## 3. Target architecture

### 3.1 Core domain (`packages/core`)

**`AgentRunner` interface** — the seam every backend implements:

```ts
interface AgentRunSpec {
  systemPrompt: string;          // built-in step prompt + bound skill body (appended)
  userPrompt: string;
  cwd: string;                   // the git worktree
  allowedTools: string[];        // step + binding allowlist
  bashAllowlist?: string[];
  model?: string;                // resolved via the binding chain (§3.5)
  maxTurns?: number;
  tokenBudget?: TokenBudget;     // best-effort; CLIs report less granularly
  responseSchema?: ZodSchema;    // structured-output extraction (owned by the step)
}
interface AgentRunner {
  readonly backend: 'anthropic-api' | 'claude-cli' | 'codex-cli';
  run(spec: AgentRunSpec, onEvent: (e: AgentEvent) => void): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
}
```

`AgentEvent` is the normalized stream (`text` · `tool-call` · `tool-result` · `token-usage` · `note` · `done` · `error`) so nothing downstream cares which backend ran.

Implementations:
- **`AnthropicApiRunner`** — extract today's `actions/autofix/agent-session.ts` behind the interface; zero behavior change (existing autofix tests stay green byte-for-byte).
- **`ClaudeCodeCliRunner`** — spawn `claude -p "<prompt>" --output-format stream-json --allowedTools … --cwd <worktree>`, parse the stream-json events into `AgentEvent`s, extract structured output from the final message. Auth = the host's logged-in subscription. Tool/cwd sandboxing via `--allowedTools`/`--disallowedTools` + worktree-only `cwd` (+ a container in cloud workers).
- **`CodexCliRunner`** — spawn `codex exec --json …` (Codex non-interactive mode), map its event stream, extract structured output. Auth = ChatGPT subscription. *Highest-risk backend* — see the Phase 0 gate and escape hatch.
- **`AgentRunnerFactory(backend, opts)`** — picks the implementation; cloud workers default to `anthropic-api`; self-hosted runners advertise which backends they can serve.

**Workflow engine** — replaces the hand-rolled `actions/autofix/orchestrator.ts` phase loop with a declarative step graph. **Workflows are code** (TS modules in `packages/core/workflows/`); they own step order, output Zod schemas, prompt builders, comment templates, loop conditions, and gates. **Bindings are data** (GUI-editable per workspace/repo): per-step `{skill?, backend?, model?, extraTools?}`, optional-step on/off, loop `maxIterations`, confidence thresholds. Authoring brand-new workflows (custom step graphs) is out of scope for v1 — the internals are data-driven so the door stays open.

```ts
type StepKind = 'analysis' | 'fix' | 'review' | 'loop' | 'effect' | 'human-gate' | 'comment';
interface WorkflowStep {
  id: string;                    // 'verify-in-repo' | 'root-cause' | 'fix' | 'review' | …
  kind: StepKind;
  defaultSkill: string;          // built-in skill name (overridable by binding, never replaced)
  promptBuilder: (ctx) => { system: string; user: string };
  tools: string[];               // default tool allowlist for the step
  outputSchema?: ZodSchema;      // the step owns the contract; a bound skill can't break it
  commentSection?: (output) => string;   // rendered into the run's living comment on completion
  gate?: (ctx) => boolean | string;       // skip / fail-fast condition
}
interface Workflow {
  id: string;                    // 'triage' | 'autofix' | 'ci-followup'
  commentTargetOrder: ['issue', 'pr'];    // pre-PR steps edit the issue comment; post-PR edit the PR comment
  steps: WorkflowStep[];
  loops?: Array<{ stepIds: string[]; until: (ctx) => boolean; maxIterations: number }>;
}
```

Built-in workflows ship as data:
- **`triage`** — cheap, *repo-less* (works from the issue digest). Steps default to today's action prompts, unchanged: `is-a-bug?` (`bug-detector`) → `priority` → `dedupe-check` → `route-decision` → output `{route: 'autofix'|'needs-info'|'label-only'|'ignore', reason}`. The ~10 other actions (auto-label, missing-info, stale, …) become **optional** triage steps / post-route effects, enableable per workspace.
- **`autofix`** — repo checked out. `verify-in-repo` (merges today's already-fixed preflight + analyzer `noActionNeeded` + "real defect vs. expected behavior", consuming the triage decision as context) → `root-cause` → `fix` → `review` → `loop(fix, review)` until `review.verdict === 'pass'` or `maxIterations` → `open-pr`. Token-budget/retry semantics live *inside* the `loop`. A `human-gate` step gates the fix when confidence is below the configured threshold (generalization of today's `confirmBeforeFix`).
- **`ci-followup`** — triggered by a `check_run` failure on an autofix PR; `attribute` → `fix` → `review` loop → `push`. (Today's `processCiFollowup` reframed.)

Each step run = one `AgentRun` record (status, backend, model, tokens, cost-estimate, summary, error). On completion the step's `commentSection` is rendered into the **run's living comment** (see §3.6).

**`SkillCatalog`** — discovers skills from the connected repo:
- On repo connect and every sync: `git fetch` the per-(workspace,repo) bare mirror (or shallow-clone), glob `<repo>/<skillsDir>/**/*.md` (`skillsDir` configurable per repo, default `.ai/skills`).
- `Skill = { name, description, body, path, suggestedStages? }`. Frontmatter is **optional**: a skill may declare `cezar-stages: [root-cause, fix]` (or be named `root-cause.md`) → it's surfaced as the *suggested* binding for those steps; skills with no hint still appear in every step's dropdown under "other repo skills". A repo file never changes behavior on its own — the binding must be confirmed/saved in the GUI.
- The `body` is appended verbatim to the bound step's system prompt under a `## Repo-specific guidance` header. The built-in prompt (and its output schema) always run.
- Catalog cached in Supabase with the commit SHA it was read at. Empty/absent `.ai/skills/` ⇒ every step uses its built-in default; the binding UI shows "(built-in default)" everywhere.

**`WorkflowBinding` / `WorkspaceSettings`** — GUI-editable, per workspace (optionally per repo):
- For each built-in step and each triage action: `{ skillName | null, backend | null, model | null, extraTools[] }` — all optional.
- Toggles: `autoTriageEnabled` (default true), `autofixEnabled` (default false, explicit opt-in), `separateCommentPerStep` (default false), per-route confidence thresholds, `maxConcurrentRuns` (tiered), loop `maxIterations`, etc.
- Persisted in Supabase (`workflow_bindings`, `workspace_settings`); the CLI reads an equivalent block from `.issuemanagerrc.json` / `.cezar/`. Empty binding ⇒ built-in defaults ⇒ behavior identical to today.

### 3.2 The 19 existing actions
Not deleted in this refactor — reframed:
- Most (`bug-detector`, `priority`, `categorize`, `security`, `quality`, `good-first-issue`, `missing-info`, `needs-response`, `claim-detector`, `contributor-welcome`, `recurring-questions`, `release-notes`, `milestone-planner`) → built-in **triage skills/steps** the GUI can bind/enable. Prompts unchanged, relocated under the skill model.
- The mutating ones (`duplicates`, `stale`, `done-detector` close issues; `auto-label` applies labels) → workflow **`effect` steps**.
- The audit doc's deletion list (`docs/audit/02-DELETION-CANDIDATES.md`) runs in **Phase 6**, not now.

### 3.3 Human-in-the-loop
"Ask the human" is a first-class **`human-gate` step**: a typed prompt + allowed responses, rendered by whichever frontend drives the run — a **cockpit decision card** (SaaS), an `@inquirer` prompt (CLI), or auto-proceed when a confidence threshold is met. The 19 actions' `interactive.ts` files and `ActionContext.interactive` become **CLI-only**; the GUI never imports them.

### 3.4 Run lifecycle controls
- **Pause = graceful, between steps.** A `pause_requested` flag lets the current step finish and write results; the run transitions to `paused` instead of dequeuing the next step (and loops stop iterating). It does **not** suspend an in-flight LLM turn — not possible with `claude -p`/`codex exec`. The cockpit must label it as such.
- **Resume** clears the flag, re-enqueues from the next step.
- **Cancel** = terminal: finish-or-kill the current step (kill the subprocess past a timeout), mark `cancelled`, dispose the worktree.
- **Re-run from step N** = clone the run, seed steps `< N` with the original's results, start at N.

### 3.5 Resolution order for a step's skill / backend / model
`step binding → workflow-run launch override → workspace default → built-in default`. A run picks **one backend at launch**; steps inherit it unless a per-step override exists. Per-step **model** override is expected to be common (cheap model for review, strong for fix); per-step **backend** override is supported but rare. Cross-backend context handoff is limited to passing the prior step's structured output — no shared conversation state across backends. Model strings are never hardcoded in workflow definitions; the GUI offers a curated, backend-aware list (data in `packages/core`: Claude API/CLI `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5` …; Codex CLI its model names) plus a free-text "custom" option. Defaults per step mirror today's `autofix.models`.

### 3.6 Comments — one living comment per run
Cezar posts **one** comment when a workflow run starts (`🤖 Cezar autofix — in progress`) and **edits** it as steps complete (a checklist: ✅ verified in repo · ✅ root cause: … · ⏳ implementing fix · …). Pre-PR steps edit the **issue** comment; once the PR exists, post-PR steps edit a single **PR** comment, and the issue comment gets a final edit linking to the PR. Per-step `commentSection` renders a *section* of the living comment, not a standalone post. Workspace toggle `separateCommentPerStep` (default off) restores one-comment-per-step for teams that want the email trail.

### 3.7 Cockpit + control plane (`packages/gui`)

New Supabase schema (one migration in Phase 3):

| Table | Purpose |
|---|---|
| `jobs` | The queue. `{id, workspace_id, repo, kind ('triage'|'autofix'|'ci-followup'), issue_number, pr_number, priority, status, required_backend, claimed_by_runner, attempts, scheduled_at, payload jsonb}` |
| `agent_runs` | One row per step execution — the cockpit's backing rows. `{id, workspace_id, job_id, parent_run_id, workflow, step_id, iteration, backend, model, status (queued|running|paused|succeeded|failed|cancelled), started_at, finished_at, tokens_used, cost_estimate, summary, error}` |
| `agent_run_events` | Streamed events for the live view (`text`/`tool`/`tool-result`/`note`/`lifecycle`). Replaces/renames `flow_events`. |
| `runners` | Managed + self-hosted. `{id, workspace_id (null = managed/global), name, kind ('cloud'|'self-hosted'), backends text[], models text[], token_hash, last_heartbeat_at, status}` |
| `workflow_bindings` | The GUI mapping: `{workspace_id, repo (null = all), step_id, skill_name, backend, model, extra_tools jsonb}` |
| `workspace_settings` | Toggles/thresholds: `auto_triage_enabled`, `autofix_enabled`, `separate_comment_per_step`, `max_concurrent_runs`, route thresholds, … |
| `repo_skills` (or JSONB on a workspace-repo row) | Cached skill catalog `{repo, commit_sha, skills jsonb}` |

`flows`, `issue_autofix_candidates`, `ci_failed_checks`, `ci_attributions`, `ci_fix_attempts` → backfilled into `jobs`+`agent_runs`; `flows` kept as a **view** over `agent_runs` for one release; old tables dropped after the 6 cron route files are deleted.

> **Implementation note (Phase 3a):** rather than making `flows` a view over `agent_runs`, the migration introduces a dedicated **`workflow_runs`** table — the top-level run (the cockpit row) — that runs *in parallel* with `flows`/`flow_events` during the transition (no view, no backfill yet). `agent_runs.workflow_run_id` references it. A later migration retires `flows`/`flow_events` once the 6 legacy cron routes are gone.

GUI pages:
- **Cockpit** (new, default landing) — the unified run list. Filters: status, repo, workflow, backend, age. Columns: issue/PR, workflow, current step, backend·model, status, tokens/cost, age. Row actions: **pause · resume · cancel · retry · re-run-from-step · open live view**. Bulk: cancel/retry selection. Empty + per-row error states. Realtime on `agent_runs`; opening a run subscribes to its `agent_run_events`.
- **Run live view** — evolved `flows/cockpit/[flowId]/cockpit-shell.tsx`: a step-graph, each node showing skill·backend·model, progress, streamed events, the comment section it produced, inline pause/cancel, and any `human-gate` decision card.
- **Settings → Workflows** — the "map agents/models/skills to steps" UI. For each built-in pipeline step and triage action: dropdowns for skill (suggested-for-this-step first, then other repo skills, then "(built-in default)") + backend + model + extra tools; toggles for optional steps; thresholds; loop max-iterations. Read-only for non-admins.
- **Settings → Runners** — register/revoke self-hosted runners (token shown once), heartbeat status, declared backends/models. Managed runner shown as always-available.
- **Settings → General** — `autoTriageEnabled`, `autofixEnabled` (with the "Cezar will open draft PRs automatically" confirmation), `separateCommentPerStep`, GitHub App install status.
- **Dashboard** card → "N running · M failed · K queued" linking to the cockpit (replaces `AutofixLoopCard`).
- **Issues** page → keep; add a per-issue "Run workflow…" launcher and the issue's run history.

Dispatcher / receivers:
- **Webhook receiver** — thin signature-validating Vercel route for the GitHub App (`issues.opened` / `issues.edited` / `issues.reopened` / `check_run.completed` / `pull_request`) → enqueues a `triage` or `ci-followup` job; no agent work in the request. Plus a ~15-min reconcile poll for missed deliveries.
- **Dispatch** — mostly the runners self-claiming jobs (`SELECT … FOR UPDATE SKIP LOCKED`), respecting per-workspace `maxConcurrentRuns`, round-robin across workspaces with pending jobs, and a per-repo GitHub-API budget. A tiny Vercel cron acts only as a **watchdog** re-queuing stalled jobs (and marking runners offline when their heartbeat lapses).

### 3.8 Runners (`packages/runner` — new package)

One package, two modes (`kind: 'cloud' | 'self-hosted'`), sharing `AgentRunner` + the workflow engine from core:
- **Managed cloud runner** = a long-running Node container (Fly.io / Railway / VM) configured `kind: cloud`; long-polls for `required_backend: anthropic-api` jobs; keeps per-(workspace,repo) bare mirrors + a fresh `git worktree` per concurrent run (LRU-evict idle mirrors, cap disk); private repos cloned with a short-lived GitHub App installation token minted per job. Topology: **Vercel** (web/API/webhooks, never runs agents) + **Supabase** (state/realtime/queue) + **≥1 cloud runner container** + **0..N self-hosted runner containers**.
- **Self-hosted runner** = `kind: self-hosted` on the team's infra. `cezar-runner login` ensures the local `claude`/`codex` CLI is authenticated; `cezar-runner start --token <runner-token> --backends claude-cli,codex-cli` long-polls the SaaS over a **scoped HTTPS API** (`GET /api/runner/jobs?backends=…`, `POST /api/runner/runs/:id/events`, `POST /api/runner/heartbeat`) — no Supabase credential ever reaches the runner. Per-runner bearer token, shown once, stored hashed, scoped to one workspace. Heartbeat lapse > N min → the dispatcher marks it offline and re-queues its in-flight jobs (attempt-capped). The SaaS mints a short-lived GitHub App token per job — no long-lived git secret on the runner. CLI sandboxing (`--allowedTools`/`--disallowedTools`, worktree-only `cwd`, optional container) is the runner's job; the job payload carries the policy. The team may point a self-hosted runner at an existing local checkout to skip cloning.

### 3.9 GitHub App
Migrate repo operations (clone, comment, label, open PR, read checks, receive webhooks) to a **GitHub App installation token**; user OAuth stays for **login only**. Required for: private-repo skill discovery, bot-identity comments ("Cezar", not a person), and webhooks. `user_github_tokens` becomes login-only / deprecated for repo ops. This is a **Phase 1** prerequisite (needed for skill discovery on private repos) and a hard requirement for Phase 5 webhooks.

### 3.10 CLI (`packages/cli`)
Stays as a **thin frontend**, not a co-equal product: (a) the solo-maintainer / no-account / local-repo entry point (interactive hub kept), and (b) the literal code base of `@cezar/runner`. New `cezar runs` / `cezar agent` commands mirror the run model locally. `cezar run <workflow> --issue N` becomes the main verb; the per-action commands stay as thin aliases that bind a single triage skill. No CLI-only polish budget. Does **not** get the cockpit, multi-workspace, or webhooks.

### 3.11 Billing
Out of scope for this plan (a pricing decision), but the schema must not block it: `agent_runs.tokens_used` (best-effort) + `agent_runs.cost_estimate` (nullable; "unknown" when a CLI doesn't report) + `agent_runs.backend`/`model` give per-run cost attribution. For now: API-key jobs cost the team directly (their key); a Cezar-key managed tier with markup is future work.

---

## 4. Phasing

Every phase is independently shippable; Phases 0–2 merge behind a flag and are individually useful. Phase 0 de-risks the riskiest unknown (do the subscription CLIs behave headlessly?) before any GUI work. The "public cockpit launch" is the end of Phase 3.

### Phase 0 — De-risk the agent abstraction (~1 week)
- Add `AgentRunner` + normalized `AgentEvent` to `packages/core`.
- `AnthropicApiRunner`: wrap today's `agent-session.ts` behind it — **zero behavior change**; `tests/actions/autofix/*` stay green byte-for-byte.
- Spike `ClaudeCodeCliRunner` and `CodexCliRunner`: run *one* analyzer step through each on a real issue in a real repo; compare structured output + tool-allowlist behavior to the API path; measure latency and recoverable usage telemetry.
- **Gate:** API + Claude CLI must produce comparable structured output and respect the tool allowlist. **Escape hatch:** if the Codex spike fails (no usable headless/structured mode, can't respect a tool allowlist), the cockpit later launches with API + Claude CLI and Codex is marked "coming soon" rather than blocking. The two Claude paths are the non-negotiable minimum.

### Phase 1 — Skill catalog + GUI step mapping + GitHub App (~2 weeks)
- **GitHub App** migration: installation tokens for clone/comment/label/PR/checks; user OAuth → login only.
- `SkillCatalog`: per-(workspace,repo) bare mirror, glob `<skillsDir>/**/*.md` (default `.ai/skills`, configurable), cache in Supabase with commit SHA. Wire the dead `config.skillsDir`.
- Supabase migration: `workflow_bindings`, `workspace_settings`, `repo_skills`.
- GUI **Settings → Workflows** + the `autoTriageEnabled`/`autofixEnabled` toggles in **Settings → General**.
- Core: the (still hand-rolled) autofix orchestrator starts *reading* the binding — appends the bound skill body to the step system prompt, picks backend/model from the binding, falls back to built-in defaults. Behavior identical when nothing is bound.

### Phase 2 — Workflow engine + per-step comments (~2 weeks)
- Implement the declarative `Workflow` engine in `packages/core/workflows/`; port `autofix` to it (`verify-in-repo → root-cause → fix → review → loop(fix,review) → open-pr`), each step emitting an `AgentRun` and a `commentSection` into the run's living comment (§3.6); token-budget/retry move inside the `loop`; add the `human-gate` step.
- Port `ci-followup` to a workflow; sketch the `triage` workflow (built-in steps wrapping the existing action prompts).
- Built-in workflows shipped as data; repo `.ai/skills/<step>.md` *suggests* a binding, GUI binding *confirms* backend/model/tools.

### Phase 3 — Job queue + cockpit (~2 weeks)  ← public cockpit launch
- Supabase migration: `jobs`, `agent_runs`, `agent_run_events`, `runners` (+ RLS). Backfill `flows`→`agent_runs` (and `flow_events`→`agent_run_events`); keep `flows` as a view one release; collapse the `ci_*`/candidates state into `jobs`+`agent_runs`. Delete the 6 cron route files; replace with the webhook receiver + watchdog cron + (initially) one always-on dev runner.
- GUI **Cockpit** page: unified run list + filters + row actions (pause/resume/cancel/retry/re-run-from-step) + bulk; **Run live view** (evolved `cockpit-shell.tsx`, step-graph); Realtime on `agent_run_events`. Dashboard card → running/failed/queued counts.

### Phase 4 — Runners + Claude/Codex CLI in production (~1.5 weeks)
- New `packages/runner` (`@cezar/runner`), one package / two `kind`s. Managed cloud runner = long-running container (Fly/Railway/VM) handling `anthropic-api` jobs. Self-hosted runner = the same code on the team's infra, scoped HTTPS API, per-runner token, heartbeat, per-job installation token.
- GUI **Settings → Runners** registration; dispatcher routes jobs by `required_backend` (managed for `anthropic-api`; self-hosted for `claude-cli`/`codex-cli`).
- Harden `ClaudeCodeCliRunner` + `CodexCliRunner` from the Phase 0 spikes: tool/cwd sandboxing, cost accounting, timeout/kill, ToS-safe defaults (confirm provider terms here).

### Phase 5 — Auto-triage on new issues (~1 week)
- GitHub App webhook → enqueue `triage` / `ci-followup` jobs (poll fallback).
- `triage` workflow → route decision → if `needsFix && autofixEnabled` (and route thresholds met) enqueue `autofix`; else post a triage summary + apply labels; below threshold → `human-gate` pause for cockpit approval.
- Conservative defaults wired: `autoTriageEnabled=true`, `autofixEnabled=false`; autofix opt-in confirmation; PRs always draft, never auto-merged.

### Phase 6 — Cleanup & convergence (~1 week)
- Run the audit deletion list (`docs/audit/02-DELETION-CANDIDATES.md`): drop the speculative display-only actions or downgrade them to optional triage skills.
- Finish CLI ↔ core convergence; ensure `.cezar/` file-backed equivalents exist for bindings/runs so the solo path doesn't bit-rot.
- Docs: README rewrite around the cockpit + skills model.

**Rough total: ~9–10 weeks.** Public cockpit at end of Phase 3; full subscription-CLI + self-hosted-runner story at end of Phase 4; auto-triage at end of Phase 5.

---

## 5. Risks & open items

- **Subscription-CLI ToS in the cloud.** Running `claude`/`codex` under a *personal* subscription on Cezar's own servers may violate provider ToS — that's why cloud runners default to API keys and subscription CLIs run on the team's self-hosted runner under their own login. Confirm provider terms before Phase 4.
- **Codex CLI maturity.** Least-proven headless/structured-output path; the Phase 0 gate + escape hatch (§Phase 0) handle a miss.
- **Serverless time limits.** Agent steps run many minutes — the managed cloud runner is a long-running container, not a Vercel function. Factored into Phases 3–4.
- **Cost accounting across backends.** API gives token usage; CLIs give less. Normalize to a best-effort `cost_estimate` with an explicit "unknown".
- **Sandboxing the CLIs.** They reach beyond the Agent SDK's `canUseTool` hook → `--allowedTools`/`--disallowedTools`, worktree-only `cwd`, container in cloud workers; policy travels with the job.
- **GitHub App migration scope.** Touches login, repo ops, and webhooks; sequenced into Phase 1 (ops) and Phase 5 (webhooks).
- **Migration of in-flight `flows`/candidates.** Backfill + views so the GUI keeps working through Phase 3.
- **Repo storage at scale.** Per-(workspace,repo) mirrors with LRU eviction; revisit a shared cache only if clone time is provably a problem.

---

## 6. What this changes at a glance

| Area | Today | After |
|---|---|---|
| Agent execution | `@anthropic-ai/claude-agent-sdk` only, API key only | `AgentRunner` interface; Anthropic API · Claude Code CLI · Codex CLI; managed cloud + optional self-hosted runners (one `packages/runner`, two `kind`s) |
| Autofix pipeline | Hardcoded `orchestrator.ts` 3-phase + retry loop | Declarative `Workflow` of steps (`verify-in-repo → root-cause → fix → review-loop → open-pr`); each step = built-in prompt + *appended* bound skill + backend + model; `human-gate` step for low-confidence approval |
| Skills | `config.skillsDir` is dead code; 3 autofix skills are TS string constants | Auto-discovered from `.ai/skills/` (configurable, empty = built-in defaults); *suggested* per step via optional `cezar-stages` frontmatter; *confirmed* via GUI binding; appended, never replacing the step prompt |
| Comments | One footer per action, content varies | One **living** comment per run (issue, then PR), edited as steps complete; `separateCommentPerStep` toggle for the old behavior |
| Human-in-loop | Per-action `interactive.ts` (CLI) + `confirmBeforeFix` (web) | First-class `human-gate` step rendered as a cockpit card / CLI prompt / auto-proceed; `interactive.ts` becomes CLI-only |
| Issue intake | 6 Vercel crons mutating status flags | GitHub App webhooks + reconcile poll → `jobs` queue → runners self-claim → workflows |
| GitHub access | User OAuth token for everything | GitHub App installation token for repo ops + webhooks; OAuth for login only |
| State | `flows` + `issue_autofix_candidates` + `ci_*` tables | `jobs` + `agent_runs` + `agent_run_events` + `runners` + `workflow_bindings` + `workspace_settings` (+ cached `repo_skills`); old tables → views, then dropped |
| GUI | Dashboard + per-flow cockpit | **Cockpit** = unified run list with controls + live step-graph; Settings → Workflows + Runners + General |
| 19 actions | Plugin system, flat menu | Triage steps/skills (most) + `effect` steps (mutating ones); reframed under the skill model; speculative ones dropped in Phase 6 |
| CLI | Co-equal frontend with the GUI | Thin frontend: solo/local mode + the basis of `@cezar/runner`; new `cezar runs` |
| Supabase | Store + 6 crons + realtime | Store + queue/runs schema + webhook receiver + watchdog cron + realtime — **fewer moving parts** |
