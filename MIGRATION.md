# Cezar — Agent Cockpit Migration / Activation Runbook

This is the operator checklist for turning on the agent-cockpit refactor (branch `feat/agent-cockpit-refactor`, plan: `docs/REFACTOR-PLAN-agent-cockpit.md`). Phases 0–5 are merged-but-dark: nothing in this work changes runtime behavior until you take the steps below. You can stop after any step — each one is independently useful and reversible.

**Companion docs:** `docs/REFACTOR-PLAN-agent-cockpit.md` (design of record), `docs/github-app-setup.md` (GitHub App + webhooks), `docs/runner-setup.md` (self-hosted runner), `docs/phase-0-notes.md` (CLI-runner caveats).

---

## What's already true (no action needed)

- The agent-cockpit refactor is the live path on `feat/agent-cockpit-refactor`. All builds/typechecks pass; `packages/core` is at 338/339 tests (the one failure is a pre-existing date-arithmetic flake in `tests/actions/stale/runner.test.ts`, unrelated to this work).
- Migrations `0007`–`0011` are present as files; only `0011_retire_legacy_path.sql` is destructive (it drops the legacy tables). Apply them in order.
- The cron routes are `/api/cron/{dispatch, triage-sweep, issue-sync}`. `dispatch` drains the `jobs` queue via `executeWorkflowJob`; `triage-sweep` enqueues triage jobs for not-yet-triaged issues; `issue-sync` is the GitHub → `issues`-table reconcile + missed-webhook safety net.
- The cockpit (`/cockpit`, `/cockpit/[runId]`) reads `workflow_runs` / `agent_runs` / `agent_run_events` live via Supabase Realtime. The `/flows` UI is retired.
- The GitHub App webhook receiver returns `503` until `GITHUB_APP_WEBHOOK_SECRET` is set, so it's a no-op until you configure it. It handles `issues`, `check_run`, `installation`, and `installation_repositories`.

---

## Step 0 — Review & merge the branch

```bash
git log --oneline 5aace57..feat/agent-cockpit-refactor   # the 5 refactor commits
git diff 5aace57..feat/agent-cockpit-refactor --stat
```

Read `docs/REFACTOR-PLAN-agent-cockpit.md` (esp. §3 and §7). Merge to your default branch when you're satisfied — merging alone changes nothing (everything below is opt-in).

---

## Step 1 — Build & sanity-check locally

```bash
yarn install
yarn typecheck        # all workspaces
yarn build            # incl. the Next.js build
yarn workspace @cezar/core run test   # 338 pass / 1 known pre-existing fail
yarn workspace @cezar/runner run build && node packages/runner/dist/cli.js help
```

---

## Step 2 — Apply the Supabase migrations

Apply, in order, to your Supabase project (review each first):

| File | Adds |
|---|---|
| `packages/gui/supabase/migrations/0007_workflow_bindings.sql` | `workflow_bindings`, `repo_skills` tables; `workspaces.auto_triage_enabled` / `autofix_enabled` / `separate_comment_per_step` columns; RLS |
| `packages/gui/supabase/migrations/0008_agent_runs.sql` | `jobs`, `workflow_runs`, `agent_runs`, `agent_run_events`, `runners` tables; RLS; `touch_updated_at` triggers; best-effort Realtime publication add |
| `packages/gui/supabase/migrations/0009_job_dispatch.sql` | `claim_next_job()` / `requeue_stalled_jobs()` RPCs (`FOR UPDATE SKIP LOCKED`) |
| `packages/gui/supabase/migrations/0010_runner_api.sql` | `claim_next_job_for_runner()` RPC; re-defines `claim_next_job()` to only return `anthropic-api`/null jobs; `requeue_jobs_for_offline_runners()`; `touch_runner_heartbeat()` |
| `packages/gui/supabase/migrations/0011_retire_legacy_path.sql` | **Destructive.** Drops `flows`, `flow_events`, `ci_failed_checks`, `ci_attributions`, `ci_fix_attempts`, `issue_autofix_candidates`, `pull_requests`; drops the `workspaces.issue_autofix_mode` column. Back up the legacy tables first if you need their history. |

```bash
# whichever you use, e.g.:
supabase db push          # if linked
# or apply each file via the SQL editor / migration tool you use
```

After this step the cockpit UI (`/cockpit`, `/cockpit/[runId]`), Settings → Workflows, and Settings → Runners pages render against the new tables. If you're applying this against a database that has legacy data, **back up `flows` / `flow_events` first** — `0011` drops them with no backfill.

---

## Step 3 — Environment variables

Set these in the GUI app's environment (Vercel project settings, `.env`, etc.):

| Var | Required for | Notes |
|---|---|---|
| `CRON_SECRET` | the cron routes | should already exist; `/api/cron/dispatch` and `/api/cron/triage-sweep` use the same bearer check as the other crons |
| `GITHUB_APP_ID` | GitHub App auth (Step 4) | numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App auth | the PEM; literal `\n` in the value is normalized to real newlines |
| `GITHUB_APP_WEBHOOK_SECRET` | the webhook receiver (Step 6) | without it `/api/github/webhook` returns 503 and you rely on the `/api/cron/triage-sweep` poll fallback |
| `NEXT_PUBLIC_APP_URL` (or `VERCEL_URL`) | Settings → Runners | used to render the ready-to-paste `cezar-runner start` command |
| `CEZAR_USE_WORKFLOW_ENGINE` | engine cutover (Step 5) | `true` flips the engine on globally; or do it per-workspace instead (see Step 5) |
| `CEZAR_DISPATCH_BATCH` | `/api/cron/dispatch` | optional, default `3` — jobs claimed per tick |
| `CEZAR_DISPATCH_STALE_MINUTES` | `/api/cron/dispatch` | optional, default `15` — stalled-job re-queue cutoff |
| `CEZAR_RUNNER_OFFLINE_MINUTES` | `/api/cron/dispatch` | optional, default `3` — dead-runner job re-queue cutoff |
| `CEZAR_TRIAGE_SWEEP_BATCH` | `/api/cron/triage-sweep` | optional, default `10` — triage jobs enqueued per workspace per tick |
| `CEZAR_INPROCESS_CRON` | self-hosted Node deployments | set to `true` to start the in-process scheduler at server boot (see "Cron source" below). Leave unset on Vercel. |
| `CEZAR_INPROCESS_CRON_BASE_URL` | in-process scheduler | optional — base URL the scheduler `fetch`es; defaults to `NEXT_PUBLIC_APP_URL` / `https://$VERCEL_URL` / `http://127.0.0.1:$PORT` |
| `CEZAR_INPROCESS_CRON_DISABLED` | in-process scheduler | optional CSV of route paths to skip, e.g. `/api/cron/ci-fix,/api/cron/issue-sync` |
| `CEZAR_DISPATCH_INTERVAL_MS` | in-process scheduler | optional, default `60000` (1 min) |
| `CEZAR_TRIAGE_SWEEP_INTERVAL_MS` | in-process scheduler | optional, default `600000` (10 min) |
| `CEZAR_CRON_ISSUE_SYNC_INTERVAL_MS` | in-process scheduler | optional, default `300000` (5 min) — matches the Vercel cadence |

### Cron source

Every `/api/cron/*` route (`dispatch`, `triage-sweep`, `issue-sync`) needs to fire on a schedule. Pick whichever fits your deployment:

- **Self-hosted long-running Node** (Docker / Fly / Railway / Render / VPS — the recommended setup): set `CEZAR_INPROCESS_CRON=true`. Next 15's `instrumentation.ts` hook starts an in-process scheduler at server boot that `fetch`es every cron route on `setInterval` at the cadence matching `vercel.json` (overridable per-route via the `CEZAR_*_INTERVAL_MS` env vars). Per-route overlap guard, idempotent boot (HMR-safe), SIGTERM/SIGINT clean. Disable individual routes via `CEZAR_INPROCESS_CRON_DISABLED` (CSV of paths). Each replica ticks independently — safe (`claim_next_job` uses `FOR UPDATE SKIP LOCKED`, the sweep and `issue-sync` upsert idempotently) just wasteful; scale horizontally only if a single replica can't keep up.
- **Vercel**: leave `CEZAR_INPROCESS_CRON` unset and let the `vercel.json` schedules drive every route.
- **External cron** (cron-job.org, GitHub Actions schedule, OS crontab, Kubernetes `CronJob`, …): leave `CEZAR_INPROCESS_CRON` unset and hit each route on its own schedule with `Authorization: Bearer $CRON_SECRET`.

Deploy the GUI app from `feat/agent-cockpit-refactor` (or after merge) and pick one of the above.

> **Heads-up (long-running agents):** `/api/cron/dispatch` and `/api/cron/issue-fix` fire-and-forget workflow execution. On a long-running Node host that's fine (the process stays alive). On serverless (Vercel) a long agent run can outlive the function; `requeue_stalled_jobs()` is the safety net, and the proper fix is running `@cezar/runner` in `--kind cloud` on a long-lived container.

---

## Step 4 — Register the GitHub App

Follow `docs/github-app-setup.md`. Summary:

- Create a GitHub App. **Repository permissions:** Contents = Read, Issues = Read & write, Pull requests = Read & write, Checks = Read, Metadata = Read.
- **Webhook:** URL `https://<your-cezar>/api/github/webhook`, secret = whatever you put in `GITHUB_APP_WEBHOOK_SECRET`. Subscribe to events: `Issues`, `Installation` (and `Pull requests` / `Check runs` are reserved for later — subscribing now is harmless).
- Install the App on the org/repo. The `installation` webhook will record `workspaces.installation_id` automatically (or set it manually).
- Effect: `GitHubAppService.isConfigured()` becomes true; repo operations (clone for skill discovery, comments, labels, PRs) and the runner's per-job token start using short-lived installation tokens. **The OAuth login flow is unchanged** — the App is additive; if `GITHUB_APP_*` aren't set, everything falls back to the existing user OAuth tokens.

---

## Step 5 — Add repo skills & per-step bindings (optional, do anytime)

1. In the target repo, optionally add `.ai/skills/*.md` files. A skill is just a Markdown file; optional YAML frontmatter `name`, `description`, `cezar-stages: [root-cause, fix]` (the `cezar-stages` hint surfaces the skill as a *suggested* binding for those steps). An empty/absent `.ai/skills/` is fully supported — every step uses its built-in default. (`config.autofix.skillsDir` defaults to `.ai/skills`; configurable.)
2. In the GUI: **Settings → Workflows** → "Refresh skills from repo" (clones the repo via the App token / OAuth, globs `.ai/skills/`, caches the catalog).
3. For each pipeline step (`verify-in-repo`, `root-cause`, `fix`, `review`) and each triage step, pick a skill / backend / model / extra tools. Empty = built-in default = today's behavior. Resolution order: step binding → run-launch override → workspace default → built-in default.

Bindings are stored in `workflow_bindings` and merged into the workspace config (`config.workflow.bindings`) by `loadWorkspaceConfig` — the engine reads them on every run.

---

## Step 6 — Flip the workflow engine on (the cutover)

The SaaS path (`/api/cron/dispatch` + `executeWorkflowJob`) always runs the declarative `Workflow` engine — no flag. For the local CLI:

- Default behavior is the legacy hand-rolled `AutofixOrchestrator` path.
- Opt into the engine for a CLI repo by setting `workflow.useEngine: true` in `.issuemanagerrc.json` (or `CEZAR_USE_WORKFLOW_ENGINE=true`). The CLI's `runs` directory under `.cezar/runs/` will then mirror each run's summary.

When the engine drives a run:
- `AutofixOrchestrator.processIssue` / `processCiFollowup` delegate to `runWorkflow(autofixWorkflow | ciFollowupWorkflow)`; the outcome is translated back to the legacy `OrchestratorOutcome` shape, so the existing callers don't change.
- A `workflow_runs` row + per-step `agent_runs` + a streamed `agent_run_events` log are written for each run → the **cockpit** (`/cockpit`) shows it live (Realtime).
- The run posts **one living comment** on the issue (edited as steps complete), then one on the PR — unless `separate_comment_per_step` is on.
- A `human-gate` step pauses the run for a cockpit decision when confidence is below the threshold.

**Test it:** open `/cockpit`, click the per-issue "Fix" button on `/issues` (it enqueues an `autofix` job via the new server action), and watch the step-graph + event log fill in as `/api/cron/dispatch` claims it.

---

## Step 7 — Webhooks & auto-triage

- With Step 4 done, `issues.opened` / `reopened` / `edited` webhooks enqueue a deduped `triage` job for the matching workspace **when `auto_triage_enabled`** (default on). The `/api/cron/dispatch` cron (or a runner) picks it up and runs `triageWorkflow` → posts a triage summary comment, applies a couple of labels (`bug`/`enhancement`/`question` + `priority:*` + `needs-info`/`invalid`/`duplicate` as appropriate), and records `route` / `issueType` / `bugConfidence` / `priority` / `bugReason` / `priorityReason` / `duplicateOf` in the run outcome **and** the issue's `analysis` JSON.
- If `route === 'autofix'` **and** the workspace has `autofix_enabled` (default **off**) **and** `issueType === 'bug'` **and** `bugConfidence ≥ config.autofix.minBugConfidence` (default 0.7) → an `autofix` job is enqueued automatically. Otherwise it just leaves the triage summary. (Below-threshold triage-driven runs don't pause for approval yet — see "Still deferred" in Step 9.)
- `check_run.completed` with a failing conclusion on a PR that an autofix run opened → enqueues a `ci-followup` job (capped at 3 prior attempts, deduped against open jobs). The `ciFollowupWorkflow.attribute` step consumes the seed carrying the failed check name(s); the fix step then commits + pushes back to the same PR branch.
- `/api/cron/triage-sweep` is the missed-webhook poll fallback (enqueues triage jobs for in-store-but-not-yet-triaged issues); `/api/cron/issue-sync` is the GitHub → `issues`-table reconcile (backfill + missed webhooks).
- Toggle `auto_triage_enabled` / `autofix_enabled` / `separate_comment_per_step` in **Settings → General → Automation** (admin only; turning on `autofix_enabled` shows a "Cezar will open draft PRs automatically" warning). PRs are always **draft**.

---

## Step 8 — (Optional) Self-hosted runner for subscription-billed agents

By default, agent runs use the Anthropic API (your `ANTHROPIC_API_KEY`) via the cron dispatcher. To run on a Claude Pro/Max or ChatGPT subscription instead, register a self-hosted runner — see `docs/runner-setup.md`. Summary:

```bash
yarn workspace @cezar/runner build
# In the GUI: Settings → Runners → Register a runner → copy the token (shown once)
cezar-runner login        # checks whether `claude` / `codex` are installed & advises `… login`
cezar-runner start --url https://<your-cezar> --token <token> --backends claude-cli,codex-cli
# or via env: CEZAR_RUNNER_URL / CEZAR_RUNNER_TOKEN
```

The runner long-polls `/api/runner/jobs`, claims jobs whose `required_backend` it serves, runs the workflow locally (clones the repo, runs the engine + the CLI agent runners), streams `agent_run_events` back, and heartbeats. Cron-dispatched jobs handle `anthropic-api`; runners handle `claude-cli` / `codex-cli`.

> **Before relying on Codex:** the `codex exec --json` event/usage schema in `CodexCliRunner` is implemented against the documented interface but hasn't been validated against a live `codex` binary (search the codebase for `phase-4-verify`). Do one live `codex` run on a real issue and confirm structured output + usage before depending on it; the Claude CLI path is solid.
>
> **ToS:** run the subscription CLIs (`claude` / `codex`) under *your own* logged-in subscription on *your own* infra (the self-hosted runner). Cezar's cloud/cron path uses API keys, not personal subscriptions.

---

## Step 9 — Phase 6 cleanup (cutover landed)

The legacy `flows`-backed path is retired. Everything below has already shipped
on `feat/agent-cockpit-refactor`; apply migration `0011_retire_legacy_path.sql`
once and your database matches the code.

### Done in Phase 6

- **`README.md` / `CLAUDE.md`** rewritten around the cockpit + skills + workflow model (this doc is the activation runbook they point to).
- **Retired the legacy crons**: `/api/cron/{issue-match, issue-fix, ci-watch, ci-attribute, ci-fix}` deleted; `vercel.json` and the in-process scheduler updated. `issue-sync` is kept as the GitHub → `issues`-table reconcile + missed-webhook safety net (now broader: upserts every open issue, not just bug-labeled). `dispatch` + `triage-sweep` drive the new path.
- **Deleted the legacy UI + glue**: the entire `packages/gui/src/app/flows/` directory, `packages/gui/src/lib/run-orchestrator.ts`, `packages/gui/src/lib/adapters/event-bridge.ts`, `packages/gui/src/lib/adapters/web-confirm.ts`, the sidebar `/flows` link, and the `Issues → Loop` column / `ActivateButton`. The dashboard's `AutofixLoopCard` is gone.
- **Rewired all dashboard/activity/analytics readers** off `flows`/`flow_events`/`ci_*`/`issue_autofix_candidates` onto `workflow_runs` / `agent_run_events`. Activity links to `/cockpit/[runId]` instead of `/flows/cockpit/[flowId]`.
- **`0011_retire_legacy_path.sql`** drops `flows`, `flow_events`, `ci_failed_checks`, `ci_attributions`, `ci_fix_attempts`, `issue_autofix_candidates`, `pull_requests`, and `workspaces.issue_autofix_mode`. No backfill — the cockpit's run history starts at the cutover.
- **Deleted the 4 display-only orphan actions** (`issue-check`, `release-notes`, `milestone-planner`, `needs-response`) and the `config.experimental` flag they hid behind. Their analysis-schema fields + `needsResponseBatchSize` config field are gone too.
- **`cezar runs`** CLI command lists / inspects local workflow-engine runs written to `<store dir>/.cezar/runs/*.json`. The web cockpit (`/cockpit`) is the SaaS equivalent.
- **Real `dedupe-check` triage step** — replaced the placeholder with an LLM call against the open-issue knowledge base (capped to 50 most-recent digested issues; effect steps now get a `store` dep). Also wired `needs-info` / `ignore` route handling: `needs-info` adds the `needs-info` label and prompts for repro details; `ignore` adds `invalid`; any detected duplicate adds `duplicate`.
- **`persist-workflow-run.ts`** helper extracts the shared `workflow_runs`/`agent_runs`/`agent_run_events` persistence. `execute-workflow-job.ts` builds one persister per run.
- **`check_run` webhook handler** wired: a failing `check_run.completed` on an autofix-owned PR (matched via `workflow_runs.pr_number`) enqueues a `ci-followup` job, capped at 3 prior attempts, deduped against open jobs. The `ciFollowupWorkflow.attribute` step still consumes the seed verbatim — a future iteration replaces the seed's static reasoning with a real LLM attribution call before enqueueing.

### Still deferred

- **Codex `phase-4-verify`**: do one live `codex exec --json` run and confirm the structured-output + usage schema in `CodexCliRunner` matches before depending on it.
- **Triage-driven `human-gate`** for below-threshold autofix candidates (today they just don't enqueue).
- **CLI ↔ core full convergence**: `.cezar/`-backed equivalents for bindings (today only `runs` is mirrored).

---

## Rollback

The cutover is now baked in — `flows` is gone, `run-orchestrator.ts` is gone, the
4 orphan actions are gone. Reverting means rolling back commits, not flipping a
flag. The non-destructive levers that remain:

- **Webhooks / auto-triage:** unset `GITHUB_APP_WEBHOOK_SECRET` (receiver returns 503) and/or set `auto_triage_enabled = false` per workspace. Uninstall the GitHub App if you want repo ops back on OAuth.
- **Cron routes:** remove the `vercel.json` entries (`dispatch` / `triage-sweep` / `issue-sync`) if you want the SaaS path quiet; the route files stay inert.
- **Runners:** revoke the token in Settings → Runners; stop the daemon.
- **Migrations:** `0011_retire_legacy_path.sql` is destructive (`DROP TABLE`). If you need to roll it back you have to restore those tables from a backup taken before applying it — there is no auto-restore. `0007`–`0010` remain additive.
- **Code:** `git revert` the relevant cleanup commits to restore the legacy path wholesale.
