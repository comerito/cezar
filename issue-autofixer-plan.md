# Cezar Issue Autofixer — Implementation Plan

**Branch:** `feat/issue-autofixer`
**Status:** Implementation complete — awaiting `npm install` and live smoke test
**Last updated:** 2026-04-13

## Progress tracker

| Step | Title | Status |
|---|---|---|
| 1  | Dependencies + schemas                 | ✅ done |
| 2  | `bug-detector` action                  | ✅ done |
| 3  | GitHubService PR extensions            | ✅ done |
| 4  | `worktree.ts` helper                   | ✅ done |
| 5  | `token-budget.ts`                      | ✅ done |
| 6  | `agent-session.ts` wrapper             | ✅ done |
| 7  | `orchestrator.ts` state machine        | ✅ done |
| 8  | Prompts + skills markdowns             | ✅ done |
| 9  | Autofix `runner` / `interactive` / `index` | ✅ done |
| 10 | Pipeline Phase 3 wiring                | ✅ done |
| 11 | Typecheck + plan finalization          | ✅ done |

Legend: ✅ done · ⏳ in progress · ⏸ pending · ❌ blocked

## What was built

**New directories**
- `src/actions/bug-detector/` — classifies every digested issue as bug/feature/question/other (prompt, runner, interactive, index).
- `src/actions/autofix/` — the orchestrated workflow:
  - `orchestrator.ts` — state machine: CREATE worktree → ANALYZE → (optional user confirm) → FIX → COMMIT → REVIEW → DECIDE → CLEANUP.
  - `worktree.ts` — `git worktree` lifecycle; refuses to run inside the cezar checkout itself.
  - `agent-session.ts` — wrapper around `@anthropic-ai/claude-agent-sdk`'s `query()`. Enforces tool allowlist, Bash command allowlist, and per-attempt token budget.
  - `token-budget.ts` — budget circuit-breaker.
  - `prompts/{analyzer,fixer,reviewer}.ts` — structured-output system prompts + Zod schemas.
  - `skills/{root-cause-analysis,fix-implementation,code-review}.md` — skill markdowns surfaced to the agent via `additionalDirectories`.
  - `runner.ts` / `interactive.ts` / `index.ts` — action-plugin surface.
- `src/types/claude-agent-sdk.d.ts` — ambient type shim so the project typechecks before `npm install`; real bundled types take over once installed.

**Modified files**
- `package.json` — added `@anthropic-ai/claude-agent-sdk`.
- `src/models/config.model.ts` — `autofix` block (required `repoRoot`, branch prefix, allowlists, token budget, …) and `bugDetectorBatchSize`.
- `src/store/store.model.ts` — bug-detector fields (`issueType`, `bugConfidence`, `bugReason`, `bugAnalyzedAt`) and autofix fields (`autofixStatus`, `autofixAttempts`, `autofixBranch`, `autofixPrUrl`, `autofixRootCause`, `autofixReviewVerdict`, …).
- `src/services/github.service.ts` — `getIssueWithComments`, `getBaseBranchSha`, `createRemoteBranch`, `pushBranch` (shells `git push`), `createPullRequest`.
- `src/pipeline/pipeline.ts` — new Phase 3 (act). Autofix is excluded from Phase 2; runs only when `--autofix` is passed to `cezar pipeline`.
- `src/index.ts` — side-effect imports for new actions; new flags on `pipeline` (`--autofix`, `--apply`, `--max-issues`) and `run` (`--issue`, `--max-issues`).
- `src/commands/run.ts` — plumbs the new flags through.

## How to use after `npm install`

```bash
# 1. Install the new dependency
npm install

# 2. Configure the external repo in .issuemanagerrc.json
# {
#   "autofix": {
#     "enabled": true,
#     "repoRoot": "/absolute/path/to/external/repo",
#     "baseBranch": "main"
#   }
# }

# 3. Digest + classify (safe, no external side effects)
cezar init
cezar run bug-detector

# 4. Dry-run autofix on a single issue (NO push, NO PR)
cezar run autofix --issue 142

# 5. Apply for real (pushes branch + opens draft PR)
cezar run autofix --issue 142 --apply

# 6. Or end-to-end including autofix
cezar pipeline --autofix --apply --max-issues 3
```

## Remaining work before production use

These follow-ups sit outside the 11-step plan scope:

- **Vitest coverage** for `orchestrator.ts`, `worktree.ts`, `token-budget.ts`, and the new GitHub service methods. I stayed focused on the feature code as requested; tests are a follow-up PR.
- **Live smoke test** against a disposable external repo with a seeded bug, end-to-end.
- **ESLint** isn't installed in this environment (pre-existing gap, unrelated).
- **Delete `src/types/claude-agent-sdk.d.ts`** once the real SDK's bundled types are verified to cover every field the wrapper uses.
- **Concurrency > 1** — the runner processes issues serially; parallel worktrees need a branch-name collision check.

---

Cezar's next super-feature: after detecting which issues are bugs, spawn an orchestrated workflow that drives a coding agent to analyze root cause, implement a fix, run a code review, and (if it passes) open a draft PR against the target repository.

---

## 0. Architectural decisions

| Concern | Choice | Rationale |
|---|---|---|
| Coding-agent worker | **`@anthropic-ai/claude-agent-sdk`** | In-process, same auth as existing `@anthropic-ai/sdk`, hooks + tool allowlists, first-party. Beats pi-mono (single-maintainer, smaller ecosystem), OpenCode (heavier subprocess server), Anthropic Managed Agents (cannot edit a locally-checked-out repo). |
| Orchestrator | Plain TS inside `src/actions/autofix/` | Matches existing action plugin pattern; no new framework. Mastra held in reserve if the orchestrator later grows into a multi-step observable pipeline. |
| Workspace isolation | `git worktree` per attempt | Prevents agents from corrupting the user's working tree; cleanly disposed per attempt. |
| PR creation | Extend `GitHubService` with `createBranch`, `pushBranch`, `createPullRequest` | Service currently lacks PR APIs. |
| Bug classification | Separate `bug-detector` action (enrichment-phase) | The in-progress `categorize` action targets *features* (`framework` / `domain` / `integration`). Mixing bug-vs-feature into it muddies the schema — keep concerns separate. |
| Target repository | **External** — `config.autofix.repoRoot` **must** be set; never operates on cezar itself or on the current CWD implicitly. | Eliminates blast-radius ambiguity; the tool manipulates a third-party checkout. |

### Resolved design questions

1. **Target repo:** External only. `repoRoot` is a required config field; the orchestrator refuses to run without it.
2. **Branch naming:** `autofix/cezar-issue-<n>` (e.g. `autofix/cezar-issue-142`).
3. **Retry policy:** Configurable via `autofix.maxAttemptsPerIssue`; reviewer notes from the previous attempt are injected as context on retry.
4. **Token budget:** Per-attempt cap enforced by the orchestrator; exceeding it aborts the attempt and marks `autofixStatus='failed'`.
5. **CI integration:** Out of scope for v1 — the PR is opened as draft; we do **not** wait for CI to go green before marking it ready.

---

## 1. Store schema additions (`src/store/store.model.ts`)

Extend `IssueAnalysisSchema`:

```ts
// Bug detector
issueType: z.enum(['bug','feature','question','other']).nullable().default(null),
bugConfidence: z.number().min(0).max(1).nullable().default(null),
bugReason: z.string().nullable().default(null),
bugAnalyzedAt: z.string().nullable().default(null),

// Autofix
autofixStatus: z.enum(['pending','running','succeeded','failed','skipped','pr-opened']).nullable().default(null),
autofixAttempts: z.number().default(0),
autofixLastRunAt: z.string().nullable().default(null),
autofixBranch: z.string().nullable().default(null),
autofixPrUrl: z.string().nullable().default(null),
autofixRootCause: z.string().nullable().default(null),
autofixReviewVerdict: z.enum(['pass','fail']).nullable().default(null),
autofixReviewNotes: z.string().nullable().default(null),
autofixWorktreePath: z.string().nullable().default(null),
autofixTokensUsed: z.number().default(0),
autofixLastError: z.string().nullable().default(null),
```

---

## 2. Config additions (`src/models/config.model.ts`)

```ts
autofix: z.object({
  enabled: z.boolean().default(false),
  repoRoot: z.string(),                    // REQUIRED when enabled: absolute path to external repo
  remote: z.string().default('origin'),
  baseBranch: z.string().default('main'),
  branchPrefix: z.string().default('autofix/cezar-issue-'),
  maxAttemptsPerIssue: z.number().default(2),
  maxConcurrent: z.number().default(1),
  tokenBudgetPerAttempt: z.number().default(250_000),
  requireReviewPass: z.boolean().default(true),
  allowedTools: z.array(z.string()).default(['Read','Edit','Write','Grep','Glob','Bash']),
  bashAllowlist: z.array(z.string()).default([
    'npm test','npm run typecheck','npm run lint',
    'git status','git diff','git log','git show',
  ]),
  draftPr: z.boolean().default(true),
  prLabels: z.array(z.string()).default(['cezar-autofix']),
  skillsDir: z.string().default('.cezar/skills'),
  minBugConfidence: z.number().min(0).max(1).default(0.7),
}).optional(),

bugDetectorBatchSize: z.number().default(15),
```

---

## 3. New action: `bug-detector` (enrichment phase)

File layout `src/actions/bug-detector/`:

- **`prompt.ts`** — Zod schema `{ issueType, confidence, reason }`; `buildBugDetectorPrompt(candidates)` formats digests for the LLM.
- **`runner.ts`** — Batched classification via existing `LLMService.analyze`. Writes `issueType`/`bugConfidence`/`bugReason`/`bugAnalyzedAt`. Honors `applyPipelineExclusions()`.
- **`interactive.ts`** — Review classified issues; allow manual override before marking stable.
- **`index.ts`** — Standard registry registration. `getBadge()` = "N unclassified" / "N bugs detected".

Not part of `CLOSE_DETECTION_ACTION_IDS` — runs in normal enrichment phase.

---

## 4. GitHubService extensions (`src/services/github.service.ts`)

```ts
async getIssueWithComments(issueNumber: number): Promise<{issue, comments[]}>
async createBranch(repo: {owner, name}, branch: string, fromSha: string): Promise<void>
async pushBranch(branch: string, localRepoPath: string): Promise<void>  // shells `git push origin <branch>`
async createPullRequest(opts: {
  repo: {owner, name},
  title: string,
  body: string,
  head: string,
  base: string,
  draft: boolean,
  labels?: string[],
}): Promise<{url: string, number: number}>
```

Unit tests mock Octokit; integration tests gated behind `GITHUB_INTEGRATION_TEST=1`.

---

## 5. New action: `autofix`

### 5.1 File layout

```
src/actions/autofix/
├── index.ts                 # ActionDefinition registration
├── runner.ts                # Top-level: select bugs → orchestrate each → print report
├── interactive.ts           # Per-issue confirm/approve gates
├── orchestrator.ts          # Per-issue state machine
├── worktree.ts              # git worktree create/cleanup helpers
├── agent-session.ts         # Thin wrapper around Claude Agent SDK
├── token-budget.ts          # Token counter + budget enforcement
├── prompts/
│   ├── analyzer.ts          # System prompt for root-cause analysis
│   ├── fixer.ts             # System prompt for fix implementation
│   └── reviewer.ts          # System prompt for code review (+ verdict schema)
└── skills/                  # Markdown skills shipped to the agent
    ├── root-cause-analysis.md
    ├── fix-implementation.md
    └── code-review.md
```

### 5.2 Orchestrator state machine

```
SELECT bug (issueType='bug', bugConfidence >= minBugConfidence,
            autofixStatus in [null,'failed'], attempts < maxAttemptsPerIssue)
  │
  ▼
CREATE worktree at <tmp>/cezar-autofix-<n>-<attempt>
CREATE branch   autofix/cezar-issue-<n>   (from baseBranch head SHA)
  │
  ▼
ANALYZE   Agent SDK session • analyzer prompt • READ-ONLY tools
          Output (structured): RootCause { summary, suspectedFiles[], hypothesis }
  │
  ▼
FIX       Agent SDK session • fixer prompt • WRITE tools + allowlisted Bash
          Hooks log every tool call; token budget enforced
          Output (structured): FixReport { changedFiles[], testCommandsRun[], notes }
  │
  ▼
VERIFY    Run allowlisted bash (npm test / typecheck / lint). Capture exit codes.
  │
  ▼
REVIEW    Agent SDK session • reviewer prompt • READ-ONLY tools + diff context
          Output (structured): ReviewVerdict { verdict: 'pass'|'fail', issues[], suggestions[] }
  │
  ├── verdict='pass'  AND  verify green
  │     ──► push branch • open draft PR • autofixStatus='pr-opened' • store PR URL
  │
  └── otherwise
        ──► autofixStatus='failed' • record reviewNotes • attempts++
            if attempts < max  AND  config.retryOnReviewFailure
              ──► loop back to CREATE (new worktree, reviewer notes injected as context)
            else
              ──► stop
  │
  ▼
CLEANUP   delete worktree (keep branch only if PR was opened)
```

### 5.3 Agent session wrapper (`agent-session.ts`)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

export async function runAgentSession<T>(opts: {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;                       // worktree path
  allowedTools: string[];
  bashAllowlist?: string[];
  responseSchema?: ZodSchema<T>;     // structured output contract
  additionalDirectories?: string[];  // e.g. skills dir
  hooks?: {
    onToolCall?: (e: ToolCallEvent) => void;
    onMessage?:  (m: MessageEvent)  => void;
  };
  maxTurns?: number;
  tokenBudget?: number;              // aborts session when exceeded
}): Promise<{
  text: string;
  parsed?: T;
  toolCalls: ToolCall[];
  tokensUsed: number;
}>;
```

Internally builds the Agent SDK `query()` call, streams events, enforces tool allowlist and Bash allowlist, validates final JSON against schema (mirroring the existing `LLMService.analyze` pattern), and trips the budget circuit-breaker when the running token total exceeds `tokenBudget`.

### 5.4 Skills shipped to the agent

- **`root-cause-analysis.md`** — how to localize the bug: read the issue + comments, restate the expected vs actual behavior, grep for relevant symbols, read suspect files end-to-end *before* forming a hypothesis. Output format strict.
- **`fix-implementation.md`** — minimal-diff principle, no scope creep, no comments unless WHY is non-obvious, prefer `Edit` over `Write`, never use `--no-verify`, never force-push. Aligned with the host project's own CLAUDE.md conventions.
- **`code-review.md`** — checklist: root cause actually addressed? Tests green? No regressions in adjacent files? No new TODOs? No secrets committed? No dead code? Returns `verdict: 'pass'|'fail'` plus structured reasons.

Skills are exposed to the agent via Agent SDK's `additionalDirectories` plus a system-prompt instruction to consult `.cezar/skills/` before acting.

---

## 6. Pipeline integration (`src/pipeline/pipeline.ts`)

- **Phase 1 (close detection):** unchanged — duplicates, done-detector.
- **Phase 2 (enrichment):** `bug-detector` joins the existing enrichment batch (priority, needs-response, categorize, etc.).
- **Phase 3 (act) — NEW:** `autofix` runs only on issues with `issueType='bug'` and `bugConfidence >= minBugConfidence`. Honors `applyPipelineExclusions()` so close-flagged bugs are skipped.

Phase 3 is opt-in and separated from enrichment so long agent runs don't block the fast digest/enrichment loop.

---

## 7. Safety & UX rules (non-negotiable)

- **Default to dry-run + interactive.** `--apply` is required to actually push branches or open PRs.
- **Approval gate** in interactive mode: after ANALYZE completes, show root-cause + plan → require user `y/N` before FIX runs.
- **Concurrency = 1** by default (`maxConcurrent`). Higher concurrency is a later enhancement (needs parallel worktrees + branch lock).
- **Bash allowlist** is enforced at the wrapper layer; the agent cannot run commands outside it. No destructive git operations (`reset --hard`, `push --force`, `clean -f`, `checkout --`).
- **No `--no-verify`**, no force-push, no commits to the base branch — enforced by the orchestrator, not trusted to the agent.
- **Draft PR** by default (`draftPr: true`). Body includes: linked issue (`Fixes #<n>`), root-cause summary, files changed, review verdict, test output transcript. Labeled `cezar-autofix`.
- **Repo allowlist:** orchestrator refuses to run unless `config.autofix.repoRoot` is set and resolves to a valid git repo that is **not** the cezar checkout itself.
- **Token budget** aborts a runaway attempt and marks it failed; no silent retries after budget-trip.

---

## 8. Implementation order (mirrors the spec's strict-order discipline)

Each step must be compilable and testable before moving on.

1. **Dependencies + schemas** — add `@anthropic-ai/claude-agent-sdk`; extend store and config schemas; `npm run typecheck`.
2. **`bug-detector` action** — full 4-file implementation with Vitest coverage; wire into enrichment phase.
3. **GitHubService extensions** — `createBranch`, `pushBranch`, `createPullRequest`, `getIssueWithComments`; Octokit-mocked unit tests.
4. **`worktree.ts`** — create/cleanup helpers; tests run against real git in `tmpdir`.
5. **`token-budget.ts`** — token counter + budget circuit-breaker; unit-tested.
6. **`agent-session.ts`** — Claude Agent SDK wrapper; smoke test against a trivial prompt.
7. **`orchestrator.ts`** — state machine with *stubbed* agent calls; exhaustive unit tests for every transition.
8. **Live end-to-end** — wire real Agent SDK into orchestrator; dry-run against a seeded synthetic bug in a throwaway repo.
9. **`interactive.ts` + `index.ts`** — registration, badges, UX prompts.
10. **Phase 3 in pipeline** — plumb `autofix` into `pipeline.ts`; add `--apply` / `--max-issues` / `--issue <n>` flags.
11. **Author skill markdowns** — `root-cause-analysis.md`, `fix-implementation.md`, `code-review.md`.
12. **Polish** — badge text, exit codes, README section, sample `.issuemanagerrc.json`.
13. **Smoke test on a real low-risk issue** in a disposable external repo before exposing to users.

---

## 9. File summary

**New files:**

```
src/actions/bug-detector/{index,runner,interactive,prompt}.ts
src/actions/autofix/{index,runner,interactive,orchestrator,worktree,agent-session,token-budget}.ts
src/actions/autofix/prompts/{analyzer,fixer,reviewer}.ts
src/actions/autofix/skills/{root-cause-analysis,fix-implementation,code-review}.md
tests/actions/bug-detector/*.test.ts
tests/actions/autofix/*.test.ts
tests/services/github.service.pr.test.ts
```

**Modified files:**

```
package.json                     + @anthropic-ai/claude-agent-sdk
src/index.ts                     + action side-effect imports
src/models/config.model.ts       + autofix config block + bugDetectorBatchSize
src/store/store.model.ts         + bug-detector and autofix analysis fields
src/services/github.service.ts   + branch/PR methods + getIssueWithComments
src/pipeline/pipeline.ts         + Phase 3 (act) + bug-detector wiring
```

Total: ~13 new source files, ~6 modified, plus tests and skills.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Agent opens a damaging PR on the wrong repo | `repoRoot` required; orchestrator refuses to run on the cezar checkout itself; draft PRs by default. |
| Agent runs unsafe shell commands | Bash allowlist enforced at wrapper layer, not trusted to the agent. |
| Runaway token cost | Per-attempt `tokenBudgetPerAttempt` circuit-breaker; attempts hard-capped by `maxAttemptsPerIssue`. |
| Flaky fix that passes review but breaks CI | Draft-only PRs; human reviewer must un-draft; `cezar-autofix` label makes them easy to find. |
| Worktree leaks on crash | Orchestrator registers cleanup hooks; `cezar status` reports orphaned worktrees. |
| Concurrent runs colliding on a branch name | v1 forces `maxConcurrent=1`; later versions will use `<prefix><n>-<attempt>` suffixing + branch existence check. |
