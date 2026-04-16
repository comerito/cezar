# Cezar — Architecture Brief for GUI Designers

> **Purpose of this document.** Cezar is an AI-powered GitHub issue manager CLI.
> This brief captures the current implementation so a GUI-design agent can
> build a graphical interface over it without re-reading the full codebase.
> **Primary focus: the `autofix` action** — the orchestrated coding-agent
> workflow that analyzes a bug, writes a patch, reviews it, and opens a draft
> PR. Autofix is the richest, most visual surface and benefits the most from a
> GUI.
>
> This is a **design brief**, not an API spec. Where the code already exposes
> clean structures (events, status enums, Zod schemas), those are called out as
> the natural binding points for a GUI.

---

## 1. What Cezar is

Cezar is a local-first CLI that:

1. **Fetches** GitHub issues into a local JSON store (`.issue-store/store.json`).
2. **Digests** each issue with Claude (short summary + keywords + category).
3. **Analyzes** digested issues via pluggable *actions* — duplicates, priority,
   auto-label, needs-response, stale, security triage, bug-detector, etc.
4. **Acts** on results — the headline "act" action is `autofix`, which spawns
   a multi-step coding agent, opens a PR in an *external* repository, and
   reports status back into the store.

The CLI runs in two modes:

- **Interactive hub** (`cezar` with no args) — a `@inquirer/prompts`-based
  terminal menu that lists every action with a live badge ("14 unclassified",
  "2 PRs open", etc.).
- **Scripted** (`cezar run <action> --apply`, `cezar pipeline --autofix`,
  `cezar sync`, `cezar init`) — for CI.

The GUI should cover **both** modes: browsing + inspecting store state, and
driving long-running agent runs live.

---

## 2. Tech stack

| Concern | Tool |
|---|---|
| Language / runtime | TypeScript 5.x (strict, ESM, NodeNext), Node 20+ |
| CLI routing | Commander.js |
| Interactive prompts | `@inquirer/prompts` (select, confirm) |
| Spinner / stage display | `ora` |
| GitHub API | `@octokit/rest` |
| LLM | `@anthropic-ai/sdk` (digests, analysis) |
| **Coding agent** | **`@anthropic-ai/claude-agent-sdk`** (autofix only) |
| Validation | Zod (store schema, config, LLM responses) |
| Config discovery | `cosmiconfig` → `.issuemanagerrc.json` |
| Tests | Vitest |
| Storage | Local JSON (no DB) |

`GITHUB_TOKEN` and `ANTHROPIC_API_KEY` are read from env.

---

## 3. Data flow (three phases + act)

```
       ┌──────────┐   ┌─────────┐   ┌─────────────┐   ┌───────────┐
       │  Fetch   │──▶│  Digest │──▶│   Analyze   │──▶│    Act    │
       │ (sync)   │   │ (Claude)│   │ (actions)   │   │ (autofix) │
       └──────────┘   └─────────┘   └─────────────┘   └───────────┘
            │              │              │                 │
            └──────────────┴──────────────┴─────────────────┘
                         Local JSON store (single source of truth)
```

The pipeline runs these in three numbered phases (`src/pipeline/pipeline.ts`):

- **Phase 1 — Close detection** — `duplicates`, `done-detector`. Their output
  is a set of "close-flagged" issue numbers that Phase 2 skips.
- **Phase 2 — Enrichment** — everything else (priority, auto-label,
  needs-response, categorize, security, stale, **bug-detector**, …).
- **Phase 3 — Act** — currently only `autofix`. **Opt-in** via `--autofix` and
  gated by `--apply` for any write.

For a GUI, Phase 3 is the "show the live agent" surface. Phases 1–2 are
batched LLM calls — fast spinners suffice.

---

## 4. The store — the GUI's primary data model

Single file: `.issue-store/store.json` (Zod-validated on load, atomic write on
save). Defined in `src/store/store.model.ts`.

```ts
Store {
  meta: { owner, repo, lastSyncedAt, totalFetched, version, orgMembers[] }
  issues: StoredIssue[]
}

StoredIssue {
  number, title, body, state: 'open'|'closed', labels[], assignees[],
  author, createdAt, updatedAt, htmlUrl, contentHash,
  commentCount, reactions, comments[], commentsFetchedAt,
  digest: { summary, category, affectedArea, keywords[], digestedAt } | null,
  analysis: IssueAnalysis            // one namespace per action
}
```

`IssueAnalysis` is flat — every action writes to its own prefixed fields:
`duplicateOf`, `priorityReason`, `suggestedLabels`, `issueType`,
`autofixStatus`, `autofixPrUrl`, … The GUI should treat the store as an
append-only fact table indexed by `issue.number`, with one small "card" per
action per issue.

### Fields specifically written by autofix

```ts
// Bug detector (prerequisite — classifies which issues are bugs)
issueType: 'bug' | 'feature' | 'question' | 'other' | null
bugConfidence: 0..1 | null
bugReason: string | null
bugAnalyzedAt: ISO-8601 | null

// Autofix lifecycle
autofixStatus: 'pending' | 'running' | 'succeeded' | 'failed'
             | 'skipped'  | 'pr-opened' | null
autofixAttempts: number
autofixLastRunAt: ISO-8601 | null
autofixBranch: string | null                       // e.g. "autofix/cezar-issue-142"
autofixPrUrl: string | null
autofixPrNumber: number | null
autofixRootCause: string | null                    // analyzer summary
autofixReviewVerdict: 'pass' | 'fail' | null
autofixReviewNotes: string | null                  // distilled blocker notes, fed into retry
autofixWorktreePath: string | null                 // live during a run
autofixTokensUsed: number
autofixLastError: string | null
```

The GUI's **Autofix tab / panel** should bind directly to these columns.

---

## 5. Actions — the plugin pattern

Every action is a self-contained plugin in `src/actions/<name>/` with
`prompt.ts`, `runner.ts`, `interactive.ts`, `index.ts`. They self-register
via side-effect import in `src/index.ts` into `actionRegistry`
(`src/actions/registry.ts`).

`ActionDefinition` (`src/actions/action.interface.ts`):

```ts
interface ActionDefinition {
  id: string;                       // CLI arg: "cezar run duplicates"
  label: string;                    // "Detect Duplicates"
  description: string;
  icon: string;                     // emoji for the menu
  group: 'triage' | 'intelligence' | 'release' | 'community';
  getBadge(store): string;          // "45 unanalyzed" / "2 bugs detected"
  isAvailable(store): true | string;
  run(ctx): Promise<void>;
}
```

Registered actions (current count: 19 including autofix and bug-detector) —
grouped by `group`:

- **triage** — duplicates, missing-info, quality, stale, done-detector,
  needs-response, issue-check, claim-detector
- **intelligence** — priority, auto-label, categorize, recurring-questions,
  good-first-issue, security, release-notes, milestone-planner, **bug-detector**,
  **autofix**
- **community** — contributor-welcome
- **release** — (release-notes sits here)

The hub menu (`src/ui/hub.ts`) renders each action as a row:

```
 🐛  Detect Bugs                 14 unclassified
 🔧  Autofix Bugs                3 eligible · 1 PR(s) open
```

The GUI equivalent is a **dashboard grid** where each tile = an action, and
each tile shows `{icon, label, badge, availability}`.

---

## 6. CLI surface (what the GUI must mirror or replace)

```
cezar init                     # first-time sync + digest
cezar sync                     # incremental pull
cezar status                   # summary
cezar run <action>             # single action, flags below
cezar pipeline                 # Phase 1 + 2 (+ Phase 3 w/ --autofix)
cezar                          # interactive hub
```

Key `run` flags:
```
--state open|closed|all
--recheck                      # re-analyze already-analyzed issues
--apply                        # perform writes (push, PR, label, comment)
--dry-run                      # preview only
--no-interactive
--issue <n>                    # target ONE issue (autofix)
--max-issues <n>               # cap per run (autofix)
--retry                        # reset autofix attempt counter
```

Key `pipeline` flags:
```
--autofix                      # include Phase 3
--apply                        # required to actually push/PR
--max-issues <n>
```

A GUI should support **Dry-Run** and **Apply** as a first-class toggle on
every destructive action, with a prominent visual difference.

---

## 7. **AUTOFIX — deep dive** (the headline feature for the GUI)

`src/actions/autofix/` orchestrates a coding agent against an **external**
checkout (never cezar itself). Pre-condition: `bug-detector` has already run
and classified the target issue as `issueType='bug'` with
`bugConfidence ≥ minBugConfidence` (default 0.7).

### 7.1 State machine — one issue, one attempt

```
                    ┌─────────────────────────────────────┐
                    │       SELECT bug candidate          │
                    └─────────────────────────────────────┘
                                    │
                                    ▼
   ┌───────────────────────────────────────────────────────────┐
   │ CREATE WORKTREE                                           │
   │   git worktree add tmp/cezar-autofix-<n>/repo             │
   │   branch: autofix/cezar-issue-<n>                         │
   │   from:   origin/<baseBranch>  (with fetchBeforeAttempt)  │
   │   refuses to run inside the cezar checkout itself         │
   └───────────────────────────────────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────┐       ┌─────────────────────────────────┐
   │ ANALYZE      │──────▶│ RootCause { summary,            │
   │ (Agent SDK)  │       │             hypothesis,         │
   │ READ-ONLY    │       │             suspectedFiles[],   │
   │ Read, Grep,  │       │             reproductionNotes,  │
   │ Glob, git    │       │             confidence 0..1 }   │
   └──────────────┘       └─────────────────────────────────┘
                                    │
             (interactive: show root-cause + ask "proceed?")
                                    │  yes
                                    ▼
   ┌──────────────┐       ┌─────────────────────────────────┐
   │ FIX          │──────▶│ FixReport { changedFiles[],     │
   │ (Agent SDK)  │       │             approach,           │
   │ WRITE tools  │       │             testCommandsRun[],  │
   │ + allowlist  │       │             remainingConcerns }│
   │   Bash       │       └─────────────────────────────────┘
   └──────────────┘
                                    │
                                    ▼
   ┌───────────────────────────────────────────────────────────┐
   │ COMMIT — git add -A && git commit                         │
   │   commit message: "fix: <title> (#n)\n\n<approach>\n\n    │
   │                     Fixes #n"                             │
   │   abort if no files changed                               │
   └───────────────────────────────────────────────────────────┘
                                    │
                                    ▼
   ┌──────────────┐       ┌─────────────────────────────────┐
   │ REVIEW       │──────▶│ ReviewVerdict { verdict,        │
   │ (Agent SDK)  │       │                 summary,        │
   │ READ-ONLY    │       │                 issues[         │
   │ + diff       │       │                   {severity,    │
   └──────────────┘       │                    file, line,  │
                          │                    comment}],   │
                          │                 suggestions[] } │
                          └─────────────────────────────────┘
                                    │
             ┌──────────────────────┴──────────────────────┐
             ▼                                             ▼
    verdict=pass & 0 blockers                 verdict=fail OR blockers>0
             │                                             │
             ▼                                             ▼
    ┌──────────────┐                       ┌─────────────────────────────┐
    │ --apply?     │                       │ retryOnReviewFailure        │
    └──────────────┘                       │  AND attempts < max?        │
        yes │  no                          └─────────────────────────────┘
            ▼  ▼                                 yes │        no
   push + PR   DRY-RUN (status:succeeded)           ▼         ▼
   status:pr-opened                          loop to CREATE   status:failed
                                             (retry notes fed into analyzer + fixer)
             │                                             │
             └────────────────────┬────────────────────────┘
                                  ▼
                     CLEANUP: dispose worktree
                     (branch is kept only if a PR was opened)
```

Source of truth: `src/actions/autofix/orchestrator.ts`. The state machine is
linear but **each leg is a long-running streaming Agent SDK session** that
the GUI should visualize live.

### 7.2 Multi-agent configuration

Three separate Claude Agent SDK sessions per attempt — they have
**different system prompts, tool allowlists, and models**:

| Role | System prompt | Tools allowed | Model (default) | Max turns (default) |
|---|---|---|---|---|
| **Analyzer** | `ANALYZER_SYSTEM_PROMPT` (embeds `ROOT_CAUSE_ANALYSIS_SKILL`) | `Read`, `Grep`, `Glob`, `Bash` (read-only: `git log`, `git diff`, `git show`, `git status`) | `claude-sonnet-4-20250514` | 15 |
| **Fixer** | `FIXER_SYSTEM_PROMPT` (embeds `FIX_IMPLEMENTATION_SKILL`) | From config: `Read, Edit, Write, Grep, Glob, Bash` + full `bashAllowlist` | `claude-sonnet-4-20250514` | 30 |
| **Reviewer** | `REVIEWER_SYSTEM_PROMPT` (embeds `CODE_REVIEW_SKILL`) | `Read`, `Grep`, `Glob` | `claude-haiku-4-5-20251001` (fast reviewer) | 10 |

All three return **structured JSON** validated by Zod schemas
(`RootCauseSchema`, `FixReportSchema`, `ReviewVerdictSchema` — see
`src/actions/autofix/prompts/*.ts`). Prompt text is in
`src/actions/autofix/skills.ts`. For a GUI: you get three well-typed
"report cards" per attempt — surface them as cards/tabs, don't just dump
JSON.

The reviewer has an important **fallback path**: if it emits prose instead of
JSON, `fallbackVerdictFromProse()` extracts any `BLOCKER`-labelled findings
and synthesizes a best-effort `fail` verdict so the retry loop keeps a
signal. The GUI should *show* when this fallback kicks in (the outcome's
`reason` field says `"reviewer emitted prose; recovered verdict=fail with N
blocker(s)"`).

### 7.3 Agent session wrapper

`src/actions/autofix/agent-session.ts` → `runAgentSession({...})` wraps the
SDK's `query()` iterator and is the **single place the GUI should hook into
for live updates**. It emits these events via the `onEvent` callback (type:
`AgentEvent`):

```ts
type AgentEvent =
  | { type: 'text';            text: string }                               // agent speaks
  | { type: 'tool';            tool: string;      input: unknown }          // agent invokes a tool
  | { type: 'tool-result';     toolUseId: string; result: string;
                               isError: boolean }                           // tool returned
  | { type: 'turn-end';        tokensUsed: number }                         // running total
  | { type: 'budget-exceeded'; used: number; limit: number }                // circuit breaker
```

Additionally the orchestrator emits higher-level lifecycle strings via
`onEvent`:

```
"[#142] Attempt 1/2 — preparing worktree"
"[#142] ANALYZE — locating root cause"
"[#142] FIX — implementing change"
"[#142] COMMIT — staging changes"
"[#142] REVIEW — running code review"
"[#142] DRY-RUN — review passed, skipping push/PR"
"[#142] PUSH — publishing branch"
"[#142] PR — opening draft pull request"
"[#142] DONE — https://github.com/owner/repo/pull/57"
"[#142] review failed — retrying with reviewer feedback (2 blocker(s))"
```

**These two streams are all the GUI needs to draw a live run.**

Enforcement performed by the wrapper:

- **Tool allowlist** — every `canUseTool` call denies tools not on the list.
- **Bash allowlist** — denies any `Bash` command not prefix-matching an entry
  from config (`bashAllowlist`). The denial message lists the allowed
  prefixes — surface it.
- **Token budget** — after each turn, a weighted token count
  (cache-read × 0.1, cache-creation × 1.25) is recorded; exceeding the
  per-attempt limit trips `TokenBudgetExceededError`, sends `interrupt()` to
  the SDK, and emits `budget-exceeded`.
- **Structured-output parse** — strips optional ```` ```json ```` fences and
  runs the text through the Zod schema; falls back to the "first `{…}`" regex
  if the whole-string parse fails. `parsed: T | null` result tells callers
  whether schema coercion succeeded.

### 7.4 Worktree lifecycle (`src/actions/autofix/worktree.ts`)

- `assertIsGitRepo(repoRoot)` + `assertNotCezarCheckout(repoRoot)` — refuses to
  run inside cezar itself (detects by remote URL).
- `git worktree prune` — clears phantom registrations from crashed attempts.
- `git fetch --prune --no-tags <remote> <baseBranch>` (if
  `fetchBeforeAttempt`), then branches from `<remote>/<baseBranch>` to sidestep
  any stale local main.
- Finds & evicts any live worktree already holding the target branch (user
  Ctrl+C scenarios).
- Creates a fresh worktree at `os.tmpdir()/cezar-autofix-<rand>/repo`.
- On retry (`resetBranch=true`): deletes the local branch first and recreates
  it. Safe because cezar only pushes on review-pass; a local branch with the
  same name is always stale.
- `dispose()` removes the worktree and its parent tmpdir. Idempotent.
- `commitAll()` / `getDiffAgainstBase()` / `listChangedFiles()` —
  orchestrator-facing helpers.

The GUI should expose the worktree path (`autofixWorktreePath`) while a run
is live — it's a power-user escape hatch to open the sandbox in an editor.

### 7.5 Token budget (`src/actions/autofix/token-budget.ts`)

- One `TokenBudget` instance per attempt (limit from
  `autofix.tokenBudgetPerAttempt`, default **250_000**).
- `.record({ inputTokens, outputTokens, cacheCreationInputTokens,
  cacheReadInputTokens })` accumulates usage.
- `.assertWithinBudget()` throws `TokenBudgetExceededError` once used ≥ limit.
- `.current` / `.remaining` / `.exceeded` are live accessors.

Display these as a progress bar next to the active agent. Shade the bar red
as it crosses ~80%.

### 7.6 Retry policy

- Per-issue attempts hard-capped by `autofix.maxAttemptsPerIssue` (default 2).
- Only **`review-failed`** attempts retry; hard failures (token budget,
  worktree setup, analyzer parse error, fixer produced no diff, etc.) break
  out of the loop immediately.
- `retryOnReviewFailure` config flag can disable retrying.
- `retryNotesFromVerdict(verdict)` distils the failed review — it keeps only
  blockers + summary — and injects them as `priorAttemptNotes` into the next
  attempt's analyzer AND fixer prompts.
- `autofixReviewNotes` persists between runs, so a `--retry` reset still
  feeds prior feedback into the next attempt.

GUI concept: a "retry history" accordion per issue showing each attempt's
`RootCause`, `FixReport`, `ReviewVerdict`.

### 7.7 Orchestrator outcome types

```ts
type OrchestratorOutcome =
  | { status: 'pr-opened';  prUrl, prNumber, branch, rootCause, verdict }
  | { status: 'skipped';    reason: string }
  | { status: 'failed';     reason, rootCause?, fixReport?, verdict?, branch? }
  | { status: 'dry-run';    rootCause, fixReport, verdict, branch, diff }
```

The GUI's per-issue result card should switch on `status` and reveal:

- **`pr-opened`** → big green "PR opened" with linkout to `prUrl`.
- **`dry-run`** → "Review passed — would open PR" + the diff (syntax-highlight).
- **`failed`** → red header + `reason` + any available artifacts (collapsible).
- **`skipped`** → muted row with `reason` (e.g. "not classified as a bug",
  "max attempts reached").

### 7.8 PR body (what lands on GitHub)

Built by `buildPrBody()` in `orchestrator.ts` — Markdown with the following
sections, in order, each populated from the structured agent outputs:

```
## Automated fix for #<n>

Fixes #<n>

> Opened by cezar autofix. Draft — a human reviewer must verify before merge.

### Root cause         ← RootCause.summary + hypothesis
### Approach           ← FixReport.approach
### Files changed      ← FixReport.changedFiles
### Verification       ← FixReport.testCommandsRun
### Review (automated) ← ReviewVerdict.verdict, summary, issues[]
### Remaining concerns ← FixReport.remainingConcerns
```

Default label: `cezar-autofix`. Default draft: `true`.

The GUI can render an identical preview *before* `--apply` so the user sees
exactly what will land.

### 7.9 Safety invariants (visible to the user)

- `autofix.repoRoot` is **required**; orchestrator refuses without it.
- Default to dry-run; `--apply` required for any write.
- Interactive confirmation gate AFTER the analyzer succeeds and BEFORE the
  fixer runs — `confirmBeforeFix(rootCause, issue) → boolean`. Today this is
  a terminal `select()`; in a GUI it becomes a modal with the root-cause
  card.
- Bash allowlist enforced at the wrapper layer (the agent literally cannot
  shell anything else).
- No `--no-verify`, no force-push, no destructive git commands; baked into
  the Fixer system prompt **and** defended by allowlist.
- Worktree refuses to run inside the cezar checkout (remote-URL check).
- Concurrency is fixed at 1 today (`maxConcurrent`). Parallel runs are
  roadmap.

---

## 8. Configuration (`.issuemanagerrc.json`)

Full schema in `src/models/config.model.ts`. The autofix block:

```jsonc
{
  "autofix": {
    "enabled": false,
    "repoRoot": "",                       // REQUIRED (absolute path)
    "remote": "origin",
    "baseBranch": "main",
    "fetchBeforeAttempt": true,
    "branchPrefix": "autofix/cezar-issue-",
    "maxAttemptsPerIssue": 2,
    "maxConcurrent": 1,
    "tokenBudgetPerAttempt": 250000,
    "requireReviewPass": true,
    "minBugConfidence": 0.7,
    "minAnalyzerConfidence": 0.5,
    "retryOnReviewFailure": true,
    "allowedTools": ["Read","Edit","Write","Grep","Glob","Bash"],
    "bashAllowlist": [
      "npm test","npm run typecheck","npm run lint","npm run build",
      "git status","git diff","git log","git show"
    ],
    "draftPr": true,
    "prLabels": ["cezar-autofix"],
    "skillsDir": ".cezar/skills",
    "models": {
      "analyzer": "claude-sonnet-4-20250514",
      "fixer":    "claude-sonnet-4-20250514",
      "reviewer": "claude-haiku-4-5-20251001"
    },
    "maxTurns": { "analyzer": 15, "fixer": 30, "reviewer": 10 }
  }
}
```

Every field above maps cleanly to a **GUI settings pane**. The most
user-facing controls are:

- `repoRoot` (path picker, validate-on-blur — must be a git repo, not cezar)
- `baseBranch` (text input)
- `minBugConfidence` (slider 0…1)
- `maxAttemptsPerIssue` (stepper 1…5)
- `tokenBudgetPerAttempt` (stepper + bytes-style display)
- `draftPr` + `requireReviewPass` (toggles)
- `bashAllowlist` (editable list with "add prefix" UX)
- Three `models.*` (dropdowns)

---

## 9. The interactive UX today — what a GUI must preserve or replace

### 9.1 Hub (`src/ui/hub.ts`)

Clears screen, renders the ASCII logo + a `boxen` status box (owner/repo,
open/closed counts, last-synced ago, digest progress), then a `select` menu
of actions grouped by `group` and annotated with `getBadge(store)`. Each
action shows the `icon + label + dim(badge)`. If an action returns an
availability string (`"no issues with digest — run init first"`) it's
`disabled` in the menu with that reason.

**GUI analogue.** A left nav listing action groups; main panel: action cards
with badges; top bar: repo, last sync, a sync button.

### 9.2 Autofix preflight (`src/actions/autofix/interactive.ts`)

Before running, presents a block:

```
Autofix preflight
───────────────────────────────────────────────────────
  Repo root:   /abs/path/to/external/repo
  Base branch: main
  Mode:        APPLY | DRY-RUN
  Max attempts per issue: 2
  Token budget per attempt: 250,000
```

Then a `confirm()` — with the `APPLY` wording spelling out the side effects
("This WILL push branches and open draft PRs…").

**GUI analogue.** A modal with the same fields, a big red/green pill for the
mode, and a separately-styled "Run dry-run" vs "Run & apply" button pair.

### 9.3 Root-cause approval gate

After analyzer succeeds:

```
Root-cause analysis for #142
───────────────────────────────────────────────────────
  Title:      Crash when input is empty
  Summary:    Null deref in formatOutput when payload is ""
  Hypothesis: The early-return guard was removed in 3f2a9; now line 47 dereferences null.
  Confidence: 0.85
  Suspected:  src/format.ts, src/cli.ts
```

Then `select(["Proceed — let the fixer agent make the change", "Skip this issue"])`.

**GUI analogue.** A modal RootCause card + Proceed/Skip. If confidence is low,
flag the card (e.g. `< 0.5` has a warning icon and a "reconsider" nudge).
This card is the *most important* interactive gate in the whole product.

### 9.4 Live run (`AutofixRunner.run`)

Uses `ora` for a single spinner that **receives stage-text updates from
`onEvent`** and, separately, prints permanent log lines for milestones (attempt
start, retry, PUSH, PR, DONE). A bound `Ctrl+O` (`verbose.ts`) toggles a
verbose live-trace of every agent event (text, tool call, tool result,
turn-end tokens, budget-exceeded). Default is quiet.

**GUI analogue.** A three-column live view per in-flight issue:
```
┌──────────────────────┬────────────────────────────────┬──────────────────────┐
│ Stage tracker        │ Agent activity feed            │ Budget + artifacts   │
│ ▸ worktree   ✓       │ ▸ tool  Grep   pattern=...     │ Tokens: 48k / 250k   │
│ ▸ analyze    ⏳      │ ◂ result ok   12 matches...    │ Model: sonnet-4      │
│ ▸ fix                │ ▸ say   "The null ref on       │ Branch: autofix/...  │
│ ▸ commit             │          line 47 is caused..." │ Worktree: /tmp/...   │
│ ▸ review             │ ▸ tool  Read   file=...        │                      │
│ ▸ push               │ ◂ result ok   420 lines        │ [Verbose toggle]     │
│ ▸ PR                 │                                │                      │
└──────────────────────┴────────────────────────────────┴──────────────────────┘
```

Bind the stage tracker to the orchestrator's `onEvent` strings (match the
regex patterns in `runner.ts` → `permanentLogPatterns`). Bind the activity
feed to `onAgentEvent` (the `AgentEvent` union).

### 9.5 Post-run summary (`AutofixResults.print`)

```
Autofix summary
───────────────────────────────────────────────────────
  #142 ✓ PR opened → https://github.com/owner/repo/pull/57
  #148 ✓ dry-run passed (branch: autofix/cezar-issue-148)
  #151 ✗ failed — analyzer confidence 0.41 below threshold 0.50
  #163 skipped — max attempts reached (use --retry to reset counter)

  PR opened: 1  ·  Dry-run: 1  ·  Failed: 1  ·  Skipped: 1
```

**GUI analogue.** A table with the four outcome buckets as column filters;
each row expandable to the full `RootCause` / `FixReport` / `ReviewVerdict`
cards; the "PR opened" rows get a linkout button.

---

## 10. Bug-detector — the prerequisite action for autofix

`src/actions/bug-detector/`. Runs in Phase 2 (enrichment). Batched LLM
classification of digested issues into `{bug, feature, question, other}`
with a `confidence` and `reason`. Writes `issueType`, `bugConfidence`,
`bugReason`, `bugAnalyzedAt`.

For a GUI: every issue card should have a "classification chip"
(🐛 / ✨ / ❓ / 📦) with the confidence as a secondary indicator. Only
`bug` chips with confidence ≥ `minBugConfidence` get the "Autofix"
action button enabled.

---

## 11. Bindings a GUI should consume

### Primary data

- **Store JSON** on disk — watch the file (fs.watch) for mutations while a
  run is in progress. Every action call ends in `store.save()`.
- **Config** via `loadConfig()` (`src/utils/config.ts`) — `cosmiconfig` picks
  up `.issuemanagerrc.json`.

### Live streams (during a run)

- **Orchestrator lifecycle events** → `onEvent: (string) => void`. Parse
  `"[#<n>] <STAGE> — <detail>"`.
- **Agent activity events** → `onAgentEvent: (AgentEvent) => void`.
- **Token usage** → `AgentEvent{type:'turn-end', tokensUsed}` +
  `autofixTokensUsed` persisted in the store.

### Terminal outcome

- `OrchestratorOutcome` (see §7.7) + store updates (`autofixStatus`,
  `autofixPrUrl`, `autofixReviewVerdict`, `autofixReviewNotes`, `autofixLastError`).

### Control surface

- Buttons should map to the existing CLI flags (`--apply`, `--dry-run`,
  `--issue <n>`, `--max-issues <n>`, `--retry`).
- The approval gate (`confirmBeforeFix`) must be surfaced as a modal; the
  runner already accepts a callback.

---

## 12. Recommended GUI information architecture

A suggested (not prescriptive) top-level layout:

```
┌─ Top bar ───────────────────────────────────────────────────────────┐
│  owner/repo  ·  78 open · 412 closed  ·  synced 4m ago   [Sync]      │
└──────────────────────────────────────────────────────────────────────┘
┌─ Left nav ─────┬─────────── Main ─────────────────────────────────────┐
│  Dashboard     │                                                     │
│                │  Action grid (19 tiles, each with live badge)       │
│  Issues        │                                                     │
│                │  Pipeline panel:  [Run Phase 1+2]  [Run with Autofix]│
│  Autofix ◀ ★   │                                                     │
│  Duplicates    │                                                     │
│  Priority      │                                                     │
│  …             │                                                     │
│  Settings      │                                                     │
└────────────────┴──────────────────────────────────────────────────────┘
```

### The Autofix screen (where the product earns its demo)

Three regions:

1. **Eligible queue (left).** List of open issues with `issueType='bug'` and
   `bugConfidence ≥ minBugConfidence`, sorted by confidence desc. Each row:
   `#n`, title, confidence, `autofixStatus` badge, attempts-used.
2. **Run cockpit (center, appears when a run is active).**
   - Breadcrumb of stages (worktree → analyze → fix → commit → review →
     push → PR).
   - **RootCause card** (revealed after analyzer) — with the approval gate
     modal if interactive.
   - **FixReport card** (revealed after fixer) — including the diff.
   - **ReviewVerdict card** (revealed after reviewer) — verdict pill, issues
     list coloured by severity.
   - Live activity feed (the `AgentEvent` stream) — with a "verbose" toggle.
   - Token budget bar, elapsed timer, worktree path link, branch link.
3. **History (right).** Each completed run as an expandable row with the
   three agent cards, PR link (if any), and a "rerun with --retry" button.

### The Autofix settings tab

One screen, grouped as:

- **Target repo** — `repoRoot`, `remote`, `baseBranch`, `fetchBeforeAttempt`.
- **Policy** — `minBugConfidence`, `minAnalyzerConfidence`,
  `maxAttemptsPerIssue`, `retryOnReviewFailure`, `requireReviewPass`.
- **Safety** — `allowedTools`, `bashAllowlist`, `draftPr`, `prLabels`,
  `branchPrefix`.
- **Budget & models** — `tokenBudgetPerAttempt`, `models.*`, `maxTurns.*`.

---

## 13. Non-goals / things the GUI should *not* try to do yet

- **Parallel autofix runs.** `maxConcurrent=1` today. Don't design the UX
  around a multi-run grid; a "1 active run + queue" model matches reality.
- **Waiting for CI.** Autofix opens a draft PR and stops — it does not poll
  CI. GUI can link out but shouldn't promise a CI-green signal.
- **Editing the fix in-place.** The worktree is disposable; edits should
  happen in the resulting draft PR on GitHub, not the local worktree.
- **Running against cezar itself.** Hard-blocked by `assertNotCezarCheckout`.
- **Operating on non-bug issues.** The autofix entry-point refuses any issue
  where `issueType !== 'bug'`. The GUI should disable the action button in
  those cases (with hover text explaining why).

---

## 14. Glossary

- **Attempt** — one pass through ANALYZE → FIX → COMMIT → REVIEW inside a
  single worktree + token budget.
- **Run** — the outer invocation that may iterate multiple attempts per
  issue and/or multiple issues.
- **Dry-run** — everything runs locally (worktree, agents, commit) but push
  + PR are skipped. Store records `autofixStatus='succeeded'`.
- **Apply** — dry-run + push + PR. Store records `autofixStatus='pr-opened'`
  with `autofixPrUrl`.
- **Verdict** — the Reviewer agent's `'pass' | 'fail'` judgment. `pass`
  with zero blockers is required to proceed to push.
- **Skill** — inline Markdown section (`skills.ts`) embedded into a system
  prompt to teach the agent a procedure without letting it browse the repo
  for doc files.
- **Worktree** — ephemeral `git worktree` created in `os.tmpdir()`. One per
  attempt. Disposed unless a PR was opened (branch kept).

---

## 15. Source-map appendix (paths the GUI agent should open for detail)

- **Store & config** — `src/store/store.model.ts`, `src/models/config.model.ts`
- **Action contract** — `src/actions/action.interface.ts`, `src/actions/registry.ts`
- **Hub UX reference** — `src/ui/hub.ts`, `src/ui/status.ts`
- **Autofix orchestrator** — `src/actions/autofix/orchestrator.ts`
- **Autofix agent wrapper (events live here)** — `src/actions/autofix/agent-session.ts`
- **Autofix prompts + schemas** — `src/actions/autofix/prompts/{analyzer,fixer,reviewer}.ts`
- **Autofix skills (prompt text)** — `src/actions/autofix/skills.ts`
- **Autofix worktree** — `src/actions/autofix/worktree.ts`
- **Token budget** — `src/actions/autofix/token-budget.ts`
- **Verbose trace (Ctrl+O)** — `src/actions/autofix/verbose.ts`
- **Runner + results** — `src/actions/autofix/runner.ts`
- **Interactive (preflight + approval gate)** — `src/actions/autofix/interactive.ts`
- **Pipeline phases** — `src/pipeline/pipeline.ts`
- **Bug detector** — `src/actions/bug-detector/{runner,interactive,prompt,index}.ts`
- **GitHub service (PR creation)** — `src/services/github.service.ts` (look
  for `getIssueWithComments`, `getBaseBranchSha`, `createRemoteBranch`,
  `pushBranch`, `createPullRequest`)
- **Feature plan (historical context)** — `issue-autofixer-plan.md`
- **Spec (full system)** — `github-issue-manager-SPEC-v3.md`

---

**End of brief.** A GUI that renders (a) the action grid with badges,
(b) a live cockpit around the autofix state machine, (c) the three agent
output cards, and (d) a settings pane bound to the autofix config block
will cover ≥95% of the product surface.
