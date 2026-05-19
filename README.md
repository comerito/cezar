<div align="center">

```
   ·  ██████╗  ███████╗ ███████╗  █████╗  ██████╗  ·
   · ██╔════╝  ██╔════╝ ╚══███╔╝ ██╔══██╗ ██╔══██╗ ·
   · ██║       █████╗     ███╔╝  ███████║ ██████╔╝ ·
   · ██║       ██╔══╝    ███╔╝   ██╔══██║ ██╔══██╗ ·
   · ╚██████╗  ███████╗ ███████╗ ██║  ██║ ██║  ██║ ·
   ·  ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ·
```

**A cockpit for AI coding agents on GitHub issues.**

Auto-triage incoming issues. Run skill-driven, multi-step autofix workflows
that end in a draft PR. Watch every agent run live — queued, running, paused,
failed, finished — with controls.

[Quick start](#quick-start) · [How it works](#how-it-works) · [The Action model](#the-action-model) · [Self-hosting](#self-hosted-runner) · [Architecture](#architecture)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/Node-20%2B-339933)
![TypeScript 5.x](https://img.shields.io/badge/TypeScript-5.x-3178c6)
![Status: active](https://img.shields.io/badge/status-active-success)

</div>

<!-- SCREENSHOT: Hero image of the cockpit at /cockpit showing multiple runs in
     mixed states (queued · running · paused · failed · finished) with status
     badges, last-step column, and the row-level controls visible on hover.
     Save as: docs/images/cockpit-hero.png  (recommended ~1600×900) -->

![Cockpit — every agent run, live](docs/images/cockpit-hero.png)

---

## Why Cezar

Most "AI for GitHub issues" tools are point solutions — a labeler, a duplicate
detector, an autofix bot. Cezar is the **cockpit** that runs them all, with a
shared model:

- **One data-driven primitive — the Action.** A system prompt, a list of
  reference skills, a set of allowed side-effects, and a trigger. No bespoke
  TypeScript plugins.
- **Skills as the reusable unit.** Markdown playbooks (built-in or pulled from
  the target repo's `.ai/skills/`) that any Action can compose into its
  prompt. Override per workspace without forking the codebase.
- **Multi-backend agents.** Anthropic API, Claude Code CLI, or Codex CLI — pick
  per workflow step. Run them on your own infra so subscription CLIs stay on
  your login.
- **Live observability.** Every agent run streams events into the cockpit
  (`workflow_runs` → `agent_runs` → `agent_run_events`) with pause / cancel /
  resume and `human-gate` steps that block on low-confidence decisions.

---

## Highlights

- **Auto-triage on every new issue.** A GitHub App webhook enqueues a triage
  pass; the runner classifies bug / feature / question, applies labels, sets
  priority on clear defects, and posts a single summary comment.
- **15 built-in Actions out of the box** — bug detection, priority, duplicates,
  auto-label, missing-info, security, quality, good-first-issue, claim detection,
  contributor welcome, recurring questions, categorization, done detection,
  stale triage, plus the auto-triage orchestrator.
- **15 built-in skills** shipped with `@cezar/core` — every Action falls back
  cleanly when the target repo has no `.ai/skills/`.
- **Two execution modes per Action.** *Declared* (effects + JSON schema —
  predictable, schema-validated) or *tool-use* (agent decides which effects
  to call mid-run via Anthropic tools).
- **Multi-step autofix workflow.** `verify-in-repo → root-cause → fix →
  review-loop → open PR` — each step binds to a skill, an agent backend, and
  a model.
- **Managed cloud + optional self-hosted runner.** Run on `ANTHROPIC_API_KEY`
  with the in-process dispatcher, or deploy the `@cezar/runner` daemon to use
  subscription CLIs under your own login.
- **Effect-scoped GitHub access.** Actions can only fire effects they declare:
  `label.add` / `label.remove` / `label.set` / `comment` / `close` / `assign` /
  `link-duplicate` / `set-priority`. No surprise mutations.
- **Solo-use CLI.** The original `cezar` interactive hub still works against a
  local JSON store — no Supabase, no GUI, no agent runs required.

---

## How it works

A bug report lands on GitHub. The GitHub App webhook enqueues a **triage** job.
The triage pass runs every enabled Action whose trigger matches `on-issue-opened`,
in deterministic order:

```
                ┌────────────────────────────────────────────────┐
GitHub  ──►─── │  webhook (issues.opened)                       │
                │   └─► jobs (deduped)                           │
                └────────────────────────────────────────────────┘
                                  │
                                  ▼
                ┌────────────────────────────────────────────────┐
                │  /api/cron/dispatch  (every 60s)               │
                │   claim_next_job · FOR UPDATE SKIP LOCKED      │
                └────────────────────────────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
      Triage pass         Autofix workflow       CI follow-up
      ┌────────────┐      ┌──────────────────┐   ┌───────────────┐
      │ auto-      │      │ verify-in-repo   │   │ classify CI   │
      │ triage     │      │ root-cause       │   │ failure       │
      │ bug-       │      │ fix              │   │ patch + push  │
      │ detector   │      │ review-loop      │   └───────────────┘
      │ priority   │      │ open PR (draft)  │
      │ duplicates │      └──────────────────┘
      │ …          │
      └────────────┘
            │
            ▼
   agent_run_events ──realtime──► Cockpit UI
```

Every step writes structured events into Supabase; the **cockpit** (`/cockpit`,
`/cockpit/[runId]`) subscribes via Supabase Realtime and renders the step graph
filling in live. A single *living comment* on the issue (then the PR) is edited
as steps complete — one comment per run, not a wall of bot chatter.

<!-- SCREENSHOT: A single run page (/cockpit/[runId]) showing the step graph
     filling in live: completed steps with green check, the current step
     spinning, the streaming event log at the bottom (text · tool-call ·
     tool-result events). Save as: docs/images/cockpit-run-detail.png -->

![Run detail — live step graph + event stream](docs/images/cockpit-run-detail.png)

<!-- SCREENSHOT: A GitHub issue showing Cezar's single "living" comment with
     the per-step progress (verify-in-repo ✓ · root-cause ✓ · fix ⏳).
     Save as: docs/images/github-issue-comment.png -->

![The living comment on a GitHub issue](docs/images/github-issue-comment.png)

---

## Quick start

### Option 1 — Solo-use CLI (no SaaS, no DB)

The original CLI works against a local JSON store. Good for one-off triage of
an issue backlog.

```bash
git clone https://github.com/comerito/cezar.git
cd cezar
yarn install
yarn build

export GITHUB_TOKEN=ghp_...
export ANTHROPIC_API_KEY=sk-ant-...

# launch the interactive hub — runs the setup wizard on first launch
node packages/cli/dist/index.js

# or non-interactive
node packages/cli/dist/index.js init -o your-org -r your-repo
node packages/cli/dist/index.js sync
node packages/cli/dist/index.js run bug-detector --apply
```

`npm link packages/cli` (or `yarn workspace cezar link`) installs the `cezar`
binary globally.

<!-- SCREENSHOT: Terminal screenshot of the `cezar` interactive hub — the
     setup-wizard greeting, then the main menu of analysis actions
     (bug-detector, duplicates, auto-label, …). Save as: docs/images/cli-hub.png -->

![CLI interactive hub](docs/images/cli-hub.png)

### Option 2 — Self-hosted SaaS (cockpit + auto-triage)

Run the full Next.js app against your own Supabase project.

```bash
# 1. provision Supabase + run migrations
cd packages/gui
npx supabase db push      # applies supabase/migrations/*.sql

# 2. set env vars (see MIGRATION.md for the full list)
cat > .env.local <<EOF
NEXT_PUBLIC_SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY="-----BEGIN..."
GITHUB_APP_WEBHOOK_SECRET=...
CRON_SECRET=...
NEXT_PUBLIC_APP_URL=https://app.example.com
EOF

# 3. run
yarn workspace @cezar/gui dev
```

Then install the GitHub App on your repo, create a workspace via
**Settings → Workspaces**, and open `/dashboard`. New issues will start
triaging automatically.

<!-- SCREENSHOT: The /dashboard page after a fresh workspace — stat row (Open
     / Closed / PRs open / Digested / Bugs), the "Recent agent runs" card, and
     the action grid below. Save as: docs/images/dashboard.png -->

![Dashboard](docs/images/dashboard.png)

### Option 3 — Self-hosted runner

Add an optional worker so subscription CLIs (`claude`, `codex`) run under
your own login on your own infra. See [Self-hosted runner](#self-hosted-runner)
below.

---

## The Action model

An **Action** is a data-driven spec — no TypeScript plugin required. It lives
either in the built-in catalog ([`packages/core/src/actions-v2/default-actions.ts`](packages/core/src/actions-v2/default-actions.ts))
or in the `actions` table for the SaaS path.

```ts
interface ActionDef {
  id: string;
  workspaceId: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  systemPrompt: string;                       // operative instruction
  skillRefs: string[];                        // composed into the system message
  target: 'issue' | 'pr';
  triggers: ActionTrigger[];                  // when to fire
  effects: EffectName[] | null;               // null = let the agent choose
  outputSchema: Record<string, unknown> | null;
  enabled: boolean;
}
```

**Triggers**: `manual`, `on-issue-opened`, `on-issue-edited`, `on-issue-reopened`,
`on-pr-opened`, `on-pr-edited`, `on-comment`, `on-check-failed`, `on-cron`.

**Effect vocabulary** (the only side-effects an Action can have on GitHub):

| Effect | Description |
|---|---|
| `label.add` / `label.remove` / `label.set` | Manage labels on the target |
| `comment` | Post a comment |
| `close` | Close the issue (`completed` / `not_planned`) |
| `assign` | Add assignees |
| `link-duplicate` | Mark as duplicate of another issue (comment + `duplicate` label) |
| `set-priority` | Apply a `priority/<level>` label |

### Two execution modes

The runner dispatches on the Action's `effects` field:

- **Declared mode** (`effects` is non-null). The system prompt is augmented
  with a strict JSON response format. The model returns
  `{ summary, effects: [{ effect, args }] }`; the runner validates each call
  against the registered Zod schema and rejects any effect the Action didn't
  declare. Predictable, auditable, easy to dry-run.

- **Tool-use mode** (`effects` is null). The full effect vocabulary is exposed
  to the model as Anthropic tools. The agent calls them mid-run; the runner
  feeds back `tool_result` blocks and loops until the model produces a final
  text response. Max 8 iterations to bound runaway runs.

Both modes share the same effect registry, the same Zod validation, and the
same audit trail.

<!-- SCREENSHOT: The Action editor (/actions/[name] or /actions/new) showing
     the system prompt textarea, the skill-ref multi-select, the trigger
     checkboxes, the effect allowlist, and the mode toggle (Declared / Tool-use).
     Save as: docs/images/action-editor.png -->

![Action editor](docs/images/action-editor.png)

### Skills as composable playbooks

`skill_refs` names skills whose markdown body is concatenated into the system
message ahead of the prompt. Skills are discovered from two sources:

- **Built-in** — shipped with `@cezar/core` (`packages/core/skills/*.md`).
- **Repo** — globbed from `<repo>/.ai/skills/**/*.md` (configurable via
  `autofix.skillsDir`). Repo skills override built-ins of the same name.

A skill is a Markdown file with optional frontmatter:

```markdown
---
name: bug-classification
description: Calibrated bug / feature / question / other rubric.
cezar-stages: [triage]
---

When classifying an issue, weight:
1. Presence of reproduction steps...
```

Empty `.ai/skills/` is fully supported — every Action uses its built-in default.

---

## Built-in Action catalog

15 Actions ship with `@cezar/core` and the corresponding skill playbooks:

| Action | Triggers | Effects | What it does |
|---|---|---|---|
| `auto-triage` | `on-issue-opened`, `on-issue-reopened` | tool-use (`label.add`, `set-priority`) | First-pass orchestrator — type labels + priority for clear critical defects |
| `bug-detector` | `on-issue-opened`, `on-issue-edited` | declared (`label.add`) | Classify bug / feature / question / other with calibrated confidence |
| `priority` | `on-issue-opened` | declared (`set-priority`) | Impact-and-urgency rubric with cited signals |
| `duplicates` | `on-issue-opened` | tool-use (`link-duplicate`) | Detect duplicates against the open-issue knowledge base (conf ≥ 0.80) |
| `auto-label` | `on-issue-opened`, `on-issue-edited` | tool-use (`label.add`, `label.remove`) | Apply repo-defined labels — never invents new ones |
| `missing-info` | `on-issue-opened` | declared (`comment`, `label.add`) | Ask for missing repro info (3-5 bullets max) |
| `security` | `on-issue-opened`, `on-issue-edited` | declared (`label.add`, `comment`) | Flag security implications, false positives preferred |
| `quality` | `on-issue-opened` | declared (`label.add`) | Detect spam / vague / test / wrong-language submissions |
| `good-first-issue` | `on-issue-opened` | declared (`label.add`) | Surface newcomer-friendly issues with a code hint |
| `claim-detector` | `on-cron` | declared (`comment`) | Find stale claims (>14 days, no PR) and post a polite nudge |
| `contributor-welcome` | `on-issue-opened` | declared (`comment`) | Personalised first-timer welcome — references issue specifics |
| `recurring-questions` | `on-cron` | declared (`comment`) | Redirect open questions already answered in closed issues |
| `categorize` | `on-issue-opened` | declared (`label.add`) | Framework / domain / integration categorization |
| `done-detector` | `on-cron` | declared (`comment`, `close`) | Find issues silently resolved by merged PRs (conf ≥ 0.70) |
| `stale` | `on-cron` | declared (`comment`, `close`, `label.add`) | Triage stale issues — close / label / keep-open |

Workspaces can override any built-in via copy-on-write — the `/actions/<name>`
page in the GUI clones the spec to a workspace-scoped row you can edit freely.

<!-- SCREENSHOT: The /actions list page showing all 15 built-in Actions with
     their trigger badges, enabled toggles, and the "Override" / "Edit" buttons.
     Save as: docs/images/actions-list.png -->

![Actions catalog](docs/images/actions-list.png)

---

## Workflow engine

Beyond single-action triage, Cezar ships a declarative engine for multi-step
agent workflows. A `Workflow` is an ordered list of steps:

```ts
type WorkflowStep =
  | { kind: 'agent';      skill: string; backend?: Backend; model?: string }
  | { kind: 'effect';     effect: EffectName; args: unknown }
  | { kind: 'human-gate'; reason: string }      // pauses for a decision
  | { kind: 'commit';     message: string }
  | { kind: 'open-pr';    draft?: boolean }
  | { kind: 'push' }
```

Three definitions ship:

- **`autofixWorkflow`** — `verify-in-repo → root-cause → fix → review-loop → open PR (draft)`.
  Loops on `review-loop` if the reviewer rejects.
- **`ciFollowupWorkflow`** — classifies a failing CI check on an autofix-owned
  PR, patches, and pushes (capped at 3 prior attempts).
- **`triageWorkflow`** — wraps the data-driven triage pass.

Per-step binding resolves through:
**step binding → run-launch override → workspace default → built-in default**.
So an unconfigured workspace behaves exactly like the defaults.

`runWorkflow` (in [`packages/core/src/workflows/workflow-engine.ts`](packages/core/src/workflows/workflow-engine.ts))
threads a blackboard, emits one `AgentRunRecord` per step, and writes
`agent_run_events` rows the cockpit subscribes to.

<!-- SCREENSHOT: Settings → Workflows page showing the autofix pipeline rows
     (verify-in-repo · root-cause · fix · review-loop · open-pr) with the
     skill / backend / model dropdowns next to each step. Save as:
     docs/images/settings-workflows.png -->

![Settings — Workflows](docs/images/settings-workflows.png)

---

## Architecture

Yarn 4 monorepo. Four packages:

| Package | Role |
|---|---|
| [`@cezar/core`](packages/core) | Engine — store schemas, GitHub/LLM services, the Action runner + effect registry, the workflow engine, the agent-runner abstraction, the skill catalog. No UI. |
| [`cezar`](packages/cli) (CLI) | Interactive hub + `init` / `sync` / `run` / `status` / `runs` commands. Solo-use front end over `@cezar/core`. |
| [`@cezar/gui`](packages/gui) | Next.js 15 app — cockpit, Inbox, Issues, Skills, Actions, Runs, Activity, Settings. Supabase-backed. GitHub App webhook + cron routes. |
| [`@cezar/runner`](packages/runner) | Optional self-hosted runner daemon. Long-polls for jobs, runs the engine locally, streams events back. |

### Three-phase data flow

1. **Fetch** — `init`/`sync` (CLI) or the `issue-sync` cron + the GitHub App
   webhook (GUI) pulls issues into the store. CLI store = `.issue-store/store.json`;
   GUI store = Supabase.
2. **Digest** — Claude generates a compact (~80-token) summary per issue:
   category, affected area, keywords. Comments are fetched and stored too.
3. **Analyze** — Actions and workflows run against digests + comments.

### Agent runner abstraction

`AgentRunner` is an interface with three implementations:

- `AnthropicApiRunner` — streaming `@anthropic-ai/sdk`, the managed-cloud default.
- `ClaudeCodeCliRunner` — wraps `claude` (the Claude Code CLI). Subscription auth.
- `CodexCliRunner` — wraps `codex exec --json` (interface implemented, live-binary
  validation pending; `grep phase-4-verify`).

A normalized `AgentEvent` stream plus an `AgentRunResult` with structured output
and cost-weighted token usage. `createAgentRunner(backend, …)` picks one.

### Job queue + cockpit

`jobs` → `workflow_runs` → `agent_runs` → `agent_run_events`, plus a `runners`
table. `/api/cron/dispatch` claims jobs with `FOR UPDATE SKIP LOCKED` and runs
them in-process via `execute-workflow-job.ts`. `/api/cron/triage-sweep` is the
missed-webhook poll fallback. `/api/cron/issue-sync` is the GitHub →
`issues`-table reconcile. `/api/runner/*` is the long-poll API for self-hosted
runners. Shared writes go through `lib/persist-workflow-run.ts`.

### Source of truth

The CLI keeps a single JSON file with atomic writes; the GUI uses Supabase
tables. Zod schemas validate everything in both paths.

---

## Self-hosted runner

The `@cezar/runner` daemon claims jobs whose backend it serves — `claude-cli`
or `codex-cli` — so subscription CLIs run under *your* login on *your* infra.
Cron-dispatched jobs (`anthropic-api`) stay on the managed path.

```bash
yarn workspace @cezar/runner build

# verify `claude` / `codex` are on PATH and logged in
node packages/runner/dist/cli.js login

# start the daemon (or `cezar-runner start ...` if linked)
node packages/runner/dist/cli.js start \
  --url   https://app.example.com \
  --token <runner-token> \
  --backends claude-cli,codex-cli
```

What it needs:

- **`claude` / `codex` on PATH** and logged in for the relevant backends.
- **`git`** on PATH. The runner clones repos to `~/.cezar/runner-repos`.
- A **runner token** created on **Settings → Runners** (shown once, stored
  hashed server-side).

The runner never sees a Supabase credential — the SaaS mints a short-lived
GitHub App token per job and ships it (plus the merged workspace config and
the issue store snapshot) in the claim response. Heartbeats every few seconds;
stalled jobs are re-queued by the dispatcher.

<!-- SCREENSHOT: Settings → Runners page showing the registered runners (name,
     backends served, last heartbeat) plus the ready-to-paste
     `cezar-runner start --url … --token … --backends …` command at the top.
     Save as: docs/images/settings-runners.png -->

![Settings — Runners](docs/images/settings-runners.png)

---

## Configuration

The CLI uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)
(`.issuemanagerrc.json` / `.yaml` / `issuemanager.config.js`). Example:

```json
{
  "github":  { "owner": "your-org", "repo": "your-repo" },
  "llm":     { "model": "claude-sonnet-4-6", "maxTokens": 4096 },
  "store":   { "path": ".issue-store" },
  "sync":    { "includeClosed": false, "digestBatchSize": 20 },
  "autofix": { "skillsDir": ".ai/skills" }
}
```

The SaaS path stores per-workspace config in Supabase; the same shape applies.

### Environment variables

The full list with which step needs each is in [`MIGRATION.md`](MIGRATION.md).
The key ones:

| Var | Used by |
|---|---|
| `GITHUB_TOKEN` | CLI / OAuth fallback for the GitHub API |
| `ANTHROPIC_API_KEY` | Claude API — digests + agent runs on the managed path |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | GitHub App auth (short-lived install tokens) |
| `GITHUB_APP_WEBHOOK_SECRET` | Webhook signature verification (until set, the receiver returns 503) |
| `CRON_SECRET` | Bearer check shared by `/api/cron/*` routes |
| `CEZAR_RUNNER_URL` / `CEZAR_RUNNER_TOKEN` | `@cezar/runner` connection defaults |
| Supabase + `NEXT_PUBLIC_APP_URL` | GUI |

The CLI auto-loads `.env` from the project root; env vars override config-file
values.

---

## Development

```bash
yarn install
yarn build                                   # topological monorepo build
yarn test                                    # all workspaces
yarn typecheck
yarn lint

# per-workspace
yarn workspace @cezar/core   run test
yarn workspace @cezar/core   run build
yarn workspace cezar         run build
yarn workspace @cezar/runner run build
yarn workspace @cezar/gui    run build
yarn workspace @cezar/gui    run dev         # Next.js dev server

# single test file
cd packages/core && npx vitest run tests/store/store.test.ts
```

### Tech stack

- **TypeScript 5.x** strict, ES2022, NodeNext/ESM (`.js` on relative imports
  in core).
- **Node 20+** — native fetch, ESM, `node:util.parseArgs`.
- **Commander.js** + **@inquirer/prompts** for the CLI.
- **@octokit/rest** + **@octokit/auth-app** for GitHub.
- **@anthropic-ai/sdk** (streaming) + **@anthropic-ai/claude-agent-sdk**.
- **Zod** for config and LLM-response validation.
- **vitest** for tests.
- **Next.js 15** + **Supabase** + **Tailwind** for the GUI.

### Adding a new Action

Built-in catalog (ships with `@cezar/core`):

1. Append an entry to [`packages/core/src/actions-v2/default-actions.ts`](packages/core/src/actions-v2/default-actions.ts).
2. Add the matching skill playbook to [`packages/core/skills/`](packages/core/skills/).
3. Mirror the row in [`packages/gui/supabase/migrations/0014_seed_default_actions.sql`](packages/gui/supabase/migrations/0014_seed_default_actions.sql)
   so the SaaS catalog matches. (A future change will seed-from-TS to remove
   the duplication.)

Workspace-scoped Action (no code change):

- Use **Actions → New** in the GUI, or override an existing built-in via
  **Actions → `<name>` → Override**. The clone is fully editable.

### Adding a new effect

1. Append an `EffectDef` to [`packages/core/src/actions-v2/effects.ts`](packages/core/src/actions-v2/effects.ts)
   with a Zod schema for its input and an `execute(args, ctx)` impl.
2. Register it in `EFFECT_REGISTRY`. The runner and the Anthropic-tools
   generator pick it up automatically — no other plumbing.

---

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — operating manual for AI assistants editing this
  repo (treats `Claude Code` as a first-class collaborator).
- [`MIGRATION.md`](MIGRATION.md) — activation runbook for the agent-cockpit
  refactor (env vars, GitHub App, Supabase setup, cron schedules).
- [`DESIGN.md`](DESIGN.md) — design system spec for the GUI.
- [`docs/REFACTOR-PLAN-agent-cockpit.md`](docs/REFACTOR-PLAN-agent-cockpit.md)
   — design of record for the cockpit + workflow engine.
- [`cezar-ROADMAP.md`](cezar-ROADMAP.md) — what's next.

---

## Contributing

Bug fixes, new Actions, new skills, new effects — all welcome. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the development workflow and code
standards (TypeScript strict, ESM, Zod at every boundary, tests for new logic).

Found a bug? Open an issue — Cezar will auto-triage it.

---

## License

[MIT](LICENSE) © [Comerito](https://github.com/comerito)
