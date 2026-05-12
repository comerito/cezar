# Cezar — Agent Cockpit Migration / Activation Runbook

This is the operator checklist for turning on the agent-cockpit refactor (branch `feat/agent-cockpit-refactor`, plan: `docs/REFACTOR-PLAN-agent-cockpit.md`). Phases 0–5 are merged-but-dark: nothing in this work changes runtime behavior until you take the steps below. You can stop after any step — each one is independently useful and reversible.

**Companion docs:** `docs/REFACTOR-PLAN-agent-cockpit.md` (design of record), `docs/github-app-setup.md` (GitHub App + webhooks), `docs/runner-setup.md` (self-hosted runner), `docs/phase-0-notes.md` (CLI-runner caveats).

---

## What's already true (no action needed)

- New code is on `feat/agent-cockpit-refactor` in 5 commits (`931b97c` phases 0–2, `3de8612` phase 3, `2d06ad1` phase 4, `c24ad83` phase 5). All builds/typechecks pass; `packages/core` is at 338/339 tests (the one failure is a pre-existing date-arithmetic flake in `tests/actions/stale/runner.test.ts`, unrelated to this work).
- `config.workflow.useEngine` defaults **off** → `AutofixOrchestrator` runs the legacy hand-rolled path exactly as before.
- Migrations `0007`–`0010` exist as files but are **not applied** to any database.
- The 6 existing cron routes (`issue-sync`, `issue-match`, `issue-fix`, `ci-watch`, `ci-attribute`, `ci-fix`) and the `flows`/`flow_events` tables / the old `/flows` UI are **untouched** and still drive the current autofix loop.
- The GitHub App webhook receiver returns `503` until `GITHUB_APP_WEBHOOK_SECRET` is set, so it's a no-op until you configure it.
- New cron routes (`/api/cron/dispatch`, `/api/cron/triage-sweep`) are added to `packages/gui/vercel.json` — they only run when deployed; they're harmless if you don't deploy this branch yet.

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

```bash
# whichever you use, e.g.:
supabase db push          # if linked
# or apply each file via the SQL editor / migration tool you use
```

`flows`/`flow_events` are left in place (no view, no backfill) — the old loop keeps working alongside. A later migration retires them once you've cut over (Phase 6).

After this step the cockpit UI (`/cockpit`, `/cockpit/[runId]`), Settings → Workflows, and Settings → Runners pages render and read these tables; they'll just be empty until you run a workflow.

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

Deploy the GUI app from `feat/agent-cockpit-refactor` (or after merge). The two new cron schedules in `vercel.json` (`/api/cron/dispatch` every minute, `/api/cron/triage-sweep` every 10 min) start running once deployed; tune the schedules to taste / your Vercel plan.

> **Heads-up (serverless duration):** `/api/cron/dispatch` fire-and-forgets workflow execution inside the serverless invocation — the same pattern as the existing `issue-fix` cron — so long agent runs can outlive the function. `requeue_stalled_jobs()` is the safety net. The real fix is running `@cezar/runner` in `--kind cloud` on a long-lived container (see Step 7 / Phase 6).

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

Two ways:

- **Global:** set `CEZAR_USE_WORKFLOW_ENGINE=true`. Every workspace's autofix runs through the declarative `Workflow` engine.
- **Per-workspace (recommended for rollout):** set `useEngine: true` inside the workspace's `config` JSONB under `workflow` (or in `.issuemanagerrc.json` → `workflow.useEngine` for the local CLI). Roll it out one workspace at a time.

When the flag is on:
- `AutofixOrchestrator.processIssue` / `processCiFollowup` delegate to `runWorkflow(autofixWorkflow | ciFollowupWorkflow)`; the outcome is translated back to the legacy `OrchestratorOutcome` shape, so the existing callers don't change.
- A `workflow_runs` row + per-step `agent_runs` + a streamed `agent_run_events` log are written for each run → the **cockpit** (`/cockpit`) shows it live (Realtime).
- The run posts **one living comment** on the issue (edited as steps complete), then one on the PR — unless `separate_comment_per_step` is on.
- A `human-gate` step pauses the run for a cockpit decision when confidence is below the threshold.

When the flag is off → byte-identical to today.

**Test it:** flip it on for one workspace, open the cockpit, and either click "Run workflow" on the cockpit / an issue, or `enqueueWorkflowRun`, or let the existing `issue-fix` cron dispatch one (it goes through `run-orchestrator.ts`, which honors the flag). Watch the step-graph + event log fill in.

---

## Step 7 — Webhooks & auto-triage

- With Step 4 done, `issues.opened` / `reopened` / `edited` webhooks enqueue a deduped `triage` job for the matching workspace **when `auto_triage_enabled`** (default on). The `/api/cron/dispatch` cron (or a runner) picks it up and runs `triageWorkflow` → posts a triage summary comment, applies a couple of labels, and records `route` / `issueType` / `bugConfidence` / `priority` in the run outcome.
- If `route === 'autofix'` **and** the workspace has `autofix_enabled` (default **off**) **and** `issueType === 'bug'` **and** `bugConfidence ≥ config.autofix.minBugConfidence` (default 0.7) → an `autofix` job is enqueued automatically. Otherwise it just leaves the triage summary. (Below-threshold triage-driven runs don't pause for approval yet — that's a Phase 6 follow-up; the threshold is the gate.)
- `/api/cron/triage-sweep` is the poll fallback for installs without webhooks / missed deliveries.
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

## Step 9 — Phase 6 (not done yet — decide when ready)

Once the new path is proven on your traffic, the remaining cleanup (deliberately left undone — it deletes working code and needs validation first):

- Retire the 6 old cron routes (`issue-sync`, `issue-match`, `issue-fix`, `ci-watch`, `ci-attribute`, `ci-fix`) and the `flows`/`flow_events` tables / `/flows` UI; a migration backfills `flows` → `workflow_runs`.
- Wire CI-followup persistence from the (now-retired) `ci-fix` path through `execute-workflow-job.ts` / the runner.
- Dedupe `run-orchestrator.ts` with `execute-workflow-job.ts`.
- Run the action-deletion list (`docs/audit/02-DELETION-CANDIDATES.md`) — drop the speculative display-only actions or downgrade them to optional triage skills.
- CLI ↔ core convergence: `.cezar/`-backed equivalents for bindings/runs so the solo CLI path doesn't bit-rot.
- Smaller `TODO(phase-5)` items: a real `dedupe-check` triage step (needs the open-issue knowledge base), `needs-info` / `ignore` route handling, a triage-driven `human-gate` for below-threshold autofix candidates.
- README rewrite around the cockpit + skills model.

---

## Rollback

Everything above is opt-in and individually reversible:

- **Engine:** unset `CEZAR_USE_WORKFLOW_ENGINE` and/or remove `workflow.useEngine` from workspace configs → autofix is back on the legacy path immediately.
- **Webhooks / auto-triage:** unset `GITHUB_APP_WEBHOOK_SECRET` (receiver returns 503) and/or set `auto_triage_enabled = false` per workspace. Uninstall the GitHub App if you want repo ops back on OAuth.
- **Cron routes:** remove the `/api/cron/dispatch` and `/api/cron/triage-sweep` entries from `vercel.json` (the route files are inert without a schedule and without queued jobs).
- **Runners:** revoke the token in Settings → Runners; stop the daemon.
- **Migrations:** `0007`–`0010` are additive (new tables/columns/RPCs). `0010` re-defines `claim_next_job()` to filter to `anthropic-api`/null — if you want the pre-`0010` behavior back, re-run the `0009` definition of that function. Dropping the new tables is safe if nothing has written to them.
- **Code:** `git revert` the relevant phase commits, or simply don't merge the branch.

The old autofix loop and `flows` UI are untouched throughout, so reverting never strands in-flight work on the old path.
