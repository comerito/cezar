# Cezar

**Cezar is a team SaaS for running AI coding agents on GitHub issues.** It's a
cockpit: every agent run — queued, running, paused, failed, finished — is visible
with controls. Incoming issues are auto-triaged. Bug fixes run as a skill-driven,
multi-step **autofix workflow** that ends in a draft PR.

```
   ·  ██████╗  ███████╗ ███████╗  █████╗  ██████╗  ·
   · ██╔════╝  ██╔════╝ ╚══███╔╝ ██╔══██╗ ██╔══██╗ ·
   · ██║       █████╗     ███╔╝  ███████║ ██████╔╝ ·
   · ██║       ██╔══╝    ███╔╝   ██╔══██║ ██╔══██╗ ·
   · ╚██████╗  ███████╗ ███████╗ ██║  ██║ ██║  ██║ ·
   ·  ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ·
              AI coding agents for GitHub issues
```

> **Status — refactor in progress.** Phases 0–5 of the agent-cockpit refactor are
> merged but **dark**: nothing changes runtime behavior until you activate it.
> See **[`MIGRATION.md`](./MIGRATION.md)** for the activation runbook and
> **[`docs/REFACTOR-PLAN-agent-cockpit.md`](./docs/REFACTOR-PLAN-agent-cockpit.md)**
> for the design of record. The legacy autofix loop (the 6 `/api/cron/*` routes)
> and the `/flows` UI remain in place until the live cutover; `config.workflow.useEngine`
> defaults **off** (legacy path runs unchanged). The solo-use **[Legacy CLI](#legacy-cli)**
> (interactive hub + `init`/`sync`/`run`/`status`) still works.

---

## Overview

A bug report lands on GitHub. Cezar's webhook receiver enqueues a **triage** job;
the triage workflow classifies it (bug / feature / question / spam …), applies a
couple of labels, posts a summary comment, and — if it's a high-confidence bug and
the workspace has autofix enabled — enqueues an **autofix** job.

The autofix workflow is a declarative pipeline of steps:

```
verify-in-repo  →  root-cause  →  fix  →  review-loop  →  open PR (draft)
```

Each step binds (in the web GUI: **Settings → Workflows**) to:

- a **skill** — a Markdown file auto-discovered from `.ai/skills/` in the target
  repo (optional YAML frontmatter: `name`, `description`, `cezar-stages`). Empty
  `.ai/skills/` is fully supported — every step falls back to its built-in default.
- an **agent backend** — Anthropic API · Claude Code CLI · Codex CLI.
- a **model** — e.g. `claude-sonnet-4`, `claude-haiku-4-5`.
- optional **extra tools**.

Resolution order: step binding → run-launch override → workspace default → built-in
default. So an unconfigured workspace behaves exactly like today.

Agents run via one of two paths:

- **Managed cloud** — your `ANTHROPIC_API_KEY`, dispatched by the `/api/cron/dispatch`
  cron (every minute). No infra to run.
- **Self-hosted runner** — the optional [`@cezar/runner`](#cezarrunner) daemon, so
  you can run subscription CLIs (`claude`, `codex`) under *your own* login on *your
  own* infra. It long-polls for jobs whose backend it serves, runs the workflow
  locally, and streams the event log back.

While a run executes, the **cockpit** (`/cockpit`, `/cockpit/[runId]`) shows the
step graph filling in live (Supabase Realtime), with pause / cancel / resume and a
`human-gate` step that pauses for a decision when fix confidence is low.

---

## Packages

This is a Yarn 4 monorepo (`packages/*`).

| Package | What it is |
|---|---|
| **`@cezar/core`** | The engine: store schemas, GitHub/LLM services, the agent-runner abstraction, the declarative workflow engine + the `autofix` / `ci-followup` / `triage` workflow definitions, the `.ai/skills/` catalog, the action plugin system, and the headless pipeline. No UI. |
| **`cezar`** (CLI) | The interactive hub + `init` / `sync` / `run` / `status` / `runs` commands. Solo-use front end over `@cezar/core`. |
| **`@cezar/gui`** | The Next.js 15 app: the cockpit, Settings (Workflows / Runners / Automation), the workspace CRUD + auth, the job queue, the GitHub App webhook receiver, and the cron routes. Supabase-backed. |
| **`@cezar/runner`** | The optional self-hosted runner daemon (`cezar-runner login` / `start`). Claims `claude-cli` / `codex-cli` jobs, runs the engine locally, heartbeats. |

---

## Architecture

**Three data phases** (the original CLI core, still how issues get into the store):

1. **Fetch** — `init`/`sync` (CLI) or the issue-sync cron (GUI) pulls issues from
   the GitHub API into the store. CLI store = a local JSON file (`.issue-store/store.json`);
   GUI store = Supabase.
2. **Digest** — Claude generates a compact (~80-token) summary per issue: category,
   affected area, keywords. Comments are fetched and stored too.
3. **Analyze** — actions (the plugin system) run against digests + comments. Each
   action writes to its own namespace; actions are independent and re-run only on
   new work.

**The workflow engine** (`@cezar/core/workflows/`): a declarative `Workflow` is an
ordered list of steps (`agent` / `effect` / `human-gate` / `commit` / `open-pr` / …)
with optional loops. `runWorkflow` executes it, threading a blackboard, emitting an
`AgentRunRecord` per step, and posting one *living* comment on the issue (then the
PR) that's edited as steps complete. Three definitions ship: `autofixWorkflow`,
`ciFollowupWorkflow`, `triageWorkflow`. The `config.workflow.useEngine` flag (default
**off**) decides whether `AutofixOrchestrator` delegates to the engine or runs its
legacy hand-rolled path.

**The job queue + cockpit** (GUI): `jobs` → `workflow_runs` → `agent_runs` →
`agent_run_events`, plus a `runners` table. `/api/cron/dispatch` claims jobs
(`claim_next_job`, `FOR UPDATE SKIP LOCKED`), runs them in-process, and re-queues
stalled ones; `/api/runner/*` is the long-poll API for self-hosted runners.
Migrations `0007`–`0010` add these (unapplied — see `MIGRATION.md`).

**Webhook receiver** (`/api/github/webhook`): GitHub App deliveries — `issues.opened`
/ `reopened` / `edited` enqueue a deduped `triage` job; `installation` records the
workspace's installation id. Returns 503 (no-op) until `GITHUB_APP_WEBHOOK_SECRET`
is set; `/api/cron/triage-sweep` is the poll fallback.

**Action plugin system** (`@cezar/core/actions/`, used by the CLI hub, the pipeline,
and the GUI): every analysis capability is a self-contained module conforming to
`ActionDefinition` (`prompt.ts` / `runner.ts` / `interactive.ts` / `index.ts`),
registered via a side-effect import. The triage workflow reuses `bug-detector` and
`priority`; auto-label / security / etc. are used directly. Four genuinely-orphaned
display-only actions (`issue-check`, `release-notes`, `milestone-planner`,
`needs-response`) are hidden from the CLI hub unless `experimental: true` — they
stay registered, so `cezar run <id>` and the GUI are unaffected.

**Store as source of truth**: the CLI's single JSON file with atomic writes; the
GUI's Supabase tables. Zod schemas validate everything.

---

## Commands

Monorepo (run from the repo root):

```bash
yarn build        # yarn workspaces foreach -A --topological-dev run build
yarn test         # all workspaces
yarn typecheck    # all workspaces
yarn lint         # all workspaces

yarn workspace @cezar/core   run test       # core unit tests (vitest)
yarn workspace cezar         run build      # build the CLI
yarn workspace @cezar/runner run build      # build the runner daemon
yarn workspace @cezar/gui    run build      # Next.js build
yarn dev                                    # tsx watch the CLI
```

CLI verbs (after `yarn workspace cezar run build`, optionally `npm link`):

```bash
cezar                                     # interactive hub (runs the setup wizard on first launch)
cezar init -o <owner> -r <repo>           # bootstrap the store without the wizard
cezar sync                                # incremental fetch
cezar status                              # store summary
cezar run <action> [--apply|--dry-run] [--no-interactive] [--format json]
cezar runs [id]                           # list / inspect local workflow-engine runs
cezar pipeline [--autofix --apply]        # full pipeline: detection → enrichment → optional autofix
```

`@cezar/runner`:

```bash
cezar-runner login                        # checks whether `claude` / `codex` are installed & logged in
cezar-runner start --url https://<cezar> --token <token> --backends claude-cli,codex-cli
```

---

## Environment variables

The full list (with which step needs each) is in **[`MIGRATION.md`](./MIGRATION.md)**.
The key ones:

| Var | For |
|---|---|
| `GITHUB_TOKEN` | GitHub API (CLI / OAuth fallback) |
| `ANTHROPIC_API_KEY` | Claude API — digests, agent runs on the managed path |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_WEBHOOK_SECRET` | the GitHub App (webhooks + short-lived install tokens); additive — OAuth login is unchanged |
| `CEZAR_USE_WORKFLOW_ENGINE` | `true` flips the workflow engine on globally (or set `workflow.useEngine` per workspace / in `.issuemanagerrc.json`) |
| `CRON_SECRET` | bearer check shared by all cron routes incl. `/api/cron/dispatch` and `/api/cron/triage-sweep` |
| `CEZAR_RUNNER_URL` / `CEZAR_RUNNER_TOKEN` | the self-hosted runner |
| Supabase + `NEXT_PUBLIC_APP_URL` (GUI) | see `MIGRATION.md` |

The CLI auto-loads `.env` from the project root; env vars override config-file values.

---

## Legacy CLI

The original solo-use Cezar still works exactly as before:

```bash
cezar                                # launch the interactive hub
```

The hub walks you through a setup wizard (owner / repo), fetches issues, generates
digests, and drops you into a menu of analysis actions (duplicates, auto-label,
priority, stale, security, …) — each with the same analyze → review-one-by-one
pattern. `init` / `sync` / `run` / `status` are the non-interactive equivalents
for CI. None of this needs Supabase, the GUI, or the workflow engine.

Configuration is via [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)
(`.issuemanagerrc.json` / `.yaml` / `issuemanager.config.js`). Example:

```json
{
  "github": { "owner": "your-org", "repo": "your-repo" },
  "llm": { "model": "claude-sonnet-4-20250514", "maxTokens": 4096 },
  "store": { "path": ".issue-store" },
  "sync": { "includeClosed": false },
  "experimental": false,
  "workflow": { "useEngine": false }
}
```

Set `experimental: true` to show the four hidden actions in the hub.

---

## Adding a new action

Each action is a self-contained folder in `packages/core/src/actions/`. To create one:

1. Create `packages/core/src/actions/your-action/` with `prompt.ts`, `runner.ts`,
   `interactive.ts`, `index.ts`.
2. Add your analysis fields to `packages/core/src/store/store.model.ts`.
3. Export the runner/prompt from `packages/core/src/index.ts` and add a side-effect
   import in `packages/cli/src/index.ts`.

See any existing action folder for the full pattern.

---

## License

[MIT](LICENSE) © [Comerito](https://github.com/comerito)
