# Cezar — Implementation Specs for Roadmap Features

All features follow the existing action plugin architecture. No new CLI commands — every feature is an `ActionDefinition` registered in the hub TUI. Users interact exclusively through `@inquirer/prompts` select/input flows inside the hub loop.

**Pattern for every new action:**
```
src/actions/{name}/
  prompt.ts       — LLM prompt builder + Zod response schema
  runner.ts       — Core logic, batching, store persistence
  interactive.ts  — TUI review flow (select/confirm prompts)
  index.ts        — ActionDefinition + actionRegistry.register()
```

**Side-effect registration** in `src/index.ts`:
```ts
import './actions/{name}/index.js';
```

---

## Shared Infrastructure Changes

These changes are required before any Phase 2+ action and should be implemented first.

### 1. Extend `IssueAnalysisSchema` (`src/store/store.model.ts`)

Add namespaced fields for every new action. All nullable, all defaulting to `null` so existing stores remain valid.

```ts
export const IssueAnalysisSchema = z.object({
  // --- Duplicates (existing) ---
  duplicateOf: z.number().nullable().default(null),
  duplicateConfidence: z.number().min(0).max(1).nullable().default(null),
  duplicateReason: z.string().nullable().default(null),
  duplicatesAnalyzedAt: z.string().nullable().default(null),

  // --- Priority (existing placeholder, now real) ---
  priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
  priorityReason: z.string().nullable().default(null),
  priorityAnalyzedAt: z.string().nullable().default(null),

  // --- Labels ---
  suggestedLabels: z.array(z.string()).nullable().default(null),
  labelsReason: z.string().nullable().default(null),
  labelsAnalyzedAt: z.string().nullable().default(null),
  labelsAppliedAt: z.string().nullable().default(null),

  // --- Missing Info ---
  missingInfoFields: z.array(z.string()).nullable().default(null),
  missingInfoComment: z.string().nullable().default(null),
  missingInfoAnalyzedAt: z.string().nullable().default(null),
  missingInfoPostedAt: z.string().nullable().default(null),

  // --- Recurring Question ---
  isRecurringQuestion: z.boolean().nullable().default(null),
  similarClosedIssues: z.array(z.number()).nullable().default(null),
  suggestedResponse: z.string().nullable().default(null),
  recurringAnalyzedAt: z.string().nullable().default(null),

  // --- Good First Issue ---
  isGoodFirstIssue: z.boolean().nullable().default(null),
  goodFirstIssueReason: z.string().nullable().default(null),
  goodFirstIssueHint: z.string().nullable().default(null),
  goodFirstIssueAnalyzedAt: z.string().nullable().default(null),

  // --- Security ---
  securityFlag: z.boolean().nullable().default(null),
  securityConfidence: z.number().min(0).max(1).nullable().default(null),
  securityCategory: z.string().nullable().default(null),
  securityAnalyzedAt: z.string().nullable().default(null),

  // --- Stale ---
  staleAction: z.enum(['close-resolved', 'close-wontfix', 'label-stale', 'keep-open']).nullable().default(null),
  staleReason: z.string().nullable().default(null),
  staleAnalyzedAt: z.string().nullable().default(null),

  // --- Quality ---
  qualityFlag: z.enum(['spam', 'vague', 'test', 'wrong-language', 'ok']).nullable().default(null),
  qualityAnalyzedAt: z.string().nullable().default(null),
});
```

### 2. Extend `ConfigSchema` (`src/models/config.model.ts`)

Add per-action config sections inside `sync`:

```ts
sync: z.object({
  digestBatchSize: z.number().default(20),
  duplicateBatchSize: z.number().default(30),
  minDuplicateConfidence: z.number().default(0.80),
  includeClosed: z.boolean().default(false),
  // New:
  labelBatchSize: z.number().default(20),
  missingInfoBatchSize: z.number().default(15),
  recurringBatchSize: z.number().default(15),
  priorityBatchSize: z.number().default(20),
  securityBatchSize: z.number().default(20),
  staleDaysThreshold: z.number().default(90),
  staleCloseDays: z.number().default(14),
}).default({}),
```

### 3. Extend `GitHubService` (`src/services/github.service.ts`)

Add methods needed by Phase 2+ actions:

```ts
async addComment(issueNumber: number, body: string): Promise<void>
async closeIssue(issueNumber: number, reason?: 'completed' | 'not_planned'): Promise<void>
async removeLabel(issueNumber: number, label: string): Promise<void>
async setLabels(issueNumber: number, labels: string[]): Promise<void>
async fetchRepoLabels(): Promise<string[]>
async getIssueComments(issueNumber: number): Promise<Array<{ author: string; body: string; createdAt: string }>>
```

### 4. Extend `LLMService` (`src/services/llm.service.ts`)

Add a generic `analyze<T>(prompt: string, schema: ZodSchema<T>): Promise<T | null>` method that any action can call. This keeps the LLM service thin — action-specific prompt building stays in each action's `prompt.ts`.

```ts
async analyze<T>(prompt: string, schema: z.ZodSchema<T>): Promise<T | null> {
  const raw = await this.callLLM(prompt);
  return this.parseJSON(raw, schema);
}
```

Existing `generateDigests` and `detectDuplicates` stay as-is.

---

## Phase 2 — Daily Triage Automation

---

### ACTION: Missing Information Request

**Directory:** `src/actions/missing-info/`

#### prompt.ts

**Response schema:**
```ts
export const MissingInfoResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    hasMissingInfo: z.boolean(),
    missingFields: z.array(z.string()),    // e.g. ["reproduction steps", "Node.js version", "OS"]
    suggestedComment: z.string(),          // Ready-to-post GitHub comment text
  })),
});
```

**Prompt builder:** `buildMissingInfoPrompt(candidates: StoredIssue[]): string`

Prompt strategy:
- Feed issue title + body (truncated to 3000 chars) + existing labels + digest
- Instructions: For each issue categorized as `bug`, determine what critical info is missing
- Context-aware: a database issue needs schema/query, a UI issue needs browser/OS, an API issue needs endpoint/request body
- Output a polite, specific GitHub comment (not a generic template)
- If nothing is missing, set `hasMissingInfo: false` and leave other fields empty
- Only analyze issues with `digest.category === 'bug'` (filter in runner, not prompt)

#### runner.ts

```ts
export interface MissingInfoOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface MissingInfoResult {
  number: number;
  title: string;
  htmlUrl: string;
  missingFields: string[];
  suggestedComment: string;
}

export class MissingInfoResults {
  constructor(
    public readonly items: MissingInfoResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): MissingInfoResults
  get isEmpty(): boolean
}

export class MissingInfoRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)

  async detect(options?: MissingInfoOptions): Promise<MissingInfoResults>
}
```

**Detection flow:**
1. Get open issues with digest where `digest.category === 'bug'`
2. Filter to unanalyzed (`missingInfoAnalyzedAt === null`) unless `recheck`
3. Batch by `config.sync.missingInfoBatchSize`
4. For each batch: call LLM, persist results immediately
5. For issues with `hasMissingInfo: false`, still write `missingInfoAnalyzedAt`
6. Return only issues where `hasMissingInfo: true`

#### interactive.ts

```ts
type MissingInfoDecision = 'post' | 'edit' | 'skip' | 'browser' | 'stop';

export class MissingInfoInteractiveUI {
  constructor(results: MissingInfoResults, config: Config)
  async present(): Promise<void>
}
```

**TUI flow for each issue with missing info:**

```
ISSUE 1 of 5 ─────────────────────────────────────────────
  #234  "Database migration fails silently"
  Missing: reproduction steps, database version, error logs

  Suggested comment:
  ┌─────────────────────────────────────────────────┐
  │ Thanks for reporting this! To help us reproduce  │
  │ the issue, could you share:                      │
  │                                                  │
  │ 1. Steps to reproduce the migration failure      │
  │ 2. Your database version (PostgreSQL/MySQL/etc)  │
  │ 3. Any error messages or logs from the migration │
  │                                                  │
  │ This will help us diagnose and fix the issue     │
  │ faster.                                          │
  └─────────────────────────────────────────────────┘

? What do you want to do with #234?
❯ Post comment + add 'needs-info' label on GitHub
  Edit comment before posting
  Skip — info is actually present
  Open in browser to check
  Stop reviewing (keep decisions so far)
```

**Decision handling:**
- `post`: Queue for GitHub posting. After review loop, confirm batch: "Post comments on N issue(s)?" → call `github.addComment()` + `github.addLabel(n, 'needs-info')` + update `missingInfoPostedAt`
- `edit`: Open `input()` prompt pre-filled with suggested comment. Then re-present same choices (minus edit)
- `skip`: Set `missingInfoFields: null, missingInfoComment: null` to clear false positive
- `browser`: Open issue URL, re-prompt
- `stop`: Break loop, apply decisions collected so far

#### index.ts

```ts
actionRegistry.register({
  id: 'missing-info',
  label: 'Request Missing Info',
  description: 'Detect bug reports missing critical information and draft follow-up comments',
  icon: '❓',

  getBadge(store) {
    const bugs = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'bug' && i.analysis.missingInfoAnalyzedAt === null);
    return bugs.length > 0 ? `${bugs.length} unchecked bugs` : 'up to date';
  },

  isAvailable(store) {
    const bugs = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'bug');
    return bugs.length > 0 ? true : 'no bug reports with digest';
  },

  async run({ store, config, interactive }) {
    const runner = new MissingInfoRunner(store, config);
    const results = await runner.detect();
    if (interactive) {
      await new MissingInfoInteractiveUI(results, config).present();
    } else {
      // Non-interactive: just print results
      for (const item of results.items) {
        console.log(`#${item.number}: missing ${item.missingFields.join(', ')}`);
      }
    }
  },
});
```

#### Tests (`tests/actions/missing-info/runner.test.ts`)

- Mock LLMService, test that only `bug` category issues are sent
- Test recheck flag
- Test empty candidates → early return
- Test batch persistence (each batch saved independently)
- Test that `hasMissingInfo: false` issues still get `missingInfoAnalyzedAt` set

---

### ACTION: Auto-Label

**Directory:** `src/actions/auto-label/`

#### prompt.ts

**Response schema:**
```ts
export const LabelResponseSchema = z.object({
  labels: z.array(z.object({
    number: z.number(),
    suggested: z.array(z.string()),     // Labels to add
    reason: z.string(),                 // One sentence explanation
  })),
});
```

**Prompt builder:** `buildLabelPrompt(candidates: StoredIssue[], repoLabels: string[]): string`

Prompt strategy:
- Feed the repo's existing label set (fetched via `github.fetchRepoLabels()`)
- Feed issue digest + title + first 2000 chars of body
- Instructions: assign labels from the repo's existing set only — do not invent labels
- Category mapping: type labels (bug, enhancement, documentation, question), area labels (inferred from content), priority labels (critical when data loss/security/crash)
- If an issue already has correct labels, return empty `suggested` array

#### runner.ts

```ts
export interface LabelOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface LabelSuggestion {
  number: number;
  title: string;
  htmlUrl: string;
  currentLabels: string[];
  suggestedLabels: string[];
  reason: string;
}

export class LabelResults {
  constructor(
    public readonly suggestions: LabelSuggestion[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): LabelResults
  get isEmpty(): boolean
}

export class AutoLabelRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async analyze(options?: LabelOptions): Promise<LabelResults>
}
```

**Flow:**
1. Fetch repo labels once via `github.fetchRepoLabels()` (cache for session)
2. Get digested issues, filter to unanalyzed (`labelsAnalyzedAt === null`) unless recheck
3. Batch by `config.sync.labelBatchSize`
4. For each batch: call LLM with candidates + repo label list
5. Persist `suggestedLabels`, `labelsReason`, `labelsAnalyzedAt` per issue
6. Return only issues where `suggestedLabels` is non-empty and differs from `currentLabels`

#### interactive.ts

```ts
type LabelDecision = 'apply' | 'partial' | 'skip' | 'browser' | 'stop';

export class AutoLabelInteractiveUI {
  constructor(results: LabelResults, config: Config)
  async present(): Promise<void>
}
```

**TUI flow for each issue with label suggestions:**

```
ISSUE 1 of 12 ─────────────────────────────────────────────
  #89  "Login broken on Safari iOS"
  Current labels: (none)
  Suggested:      bug, area: auth, browser: safari

  Reason: Bug report about authentication failure on Safari iOS browser

? What do you want to do with #89?
❯ Apply all suggested labels on GitHub
  Select which labels to apply
  Skip — current labels are fine
  Open in browser to check
  Stop reviewing (keep decisions so far)
```

**Decision handling:**
- `apply`: Queue all suggested labels for GitHub application
- `partial`: Show `checkbox()` prompt with suggested labels, user picks subset. Queue selected labels
- `skip`: Clear `suggestedLabels` in analysis
- `browser` / `stop`: Same pattern as duplicates

After review loop: "Apply labels to N issue(s)?" → batch call `github.setLabels()` for each, update `labelsAppliedAt`.

#### index.ts

```ts
actionRegistry.register({
  id: 'auto-label',
  label: 'Auto-Label Issues',
  description: 'Suggest and apply labels based on issue content',
  icon: '🏷️',

  getBadge(store) {
    const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.labelsAnalyzedAt === null).length;
    return unanalyzed > 0 ? `${unanalyzed} unlabeled` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    return withDigest.length > 0 ? true : 'no issues with digest';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

#### Tests

- Mock LLMService + GitHubService
- Test that only repo's existing labels are suggested (prompt includes label set)
- Test filtering: issues with unchanged labels return empty suggestions
- Test partial label selection flow

---

### ACTION: Recurring Question Detection

**Directory:** `src/actions/recurring-questions/`

#### prompt.ts

**Response schema:**
```ts
export const RecurringQuestionResponseSchema = z.object({
  questions: z.array(z.object({
    number: z.number(),
    isRecurring: z.boolean(),
    similarClosedIssues: z.array(z.number()),    // Numbers of closed issues with answers
    suggestedResponse: z.string(),               // Draft comment linking to prior answers
    confidence: z.number().min(0).max(1),
  })),
});
```

**Prompt builder:** `buildRecurringQuestionPrompt(candidates: StoredIssue[], closedQuestions: StoredIssue[]): string`

Prompt strategy:
- Candidates: open issues with `digest.category === 'question'`
- Knowledge base: closed issues (all categories) — use compact digest format
- Instructions: For each candidate, determine if a substantially similar question was already answered in a closed issue
- The suggested response should reference the closed issue number(s) and summarize the answer — do NOT invent answers, only link to existing ones
- If no match, set `isRecurring: false`

#### runner.ts

```ts
export interface RecurringQuestionOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface RecurringQuestionResult {
  number: number;
  title: string;
  htmlUrl: string;
  similarClosedIssues: Array<{ number: number; title: string }>;
  suggestedResponse: string;
  confidence: number;
}

export class RecurringQuestionResults {
  constructor(
    public readonly items: RecurringQuestionResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): RecurringQuestionResults
  get isEmpty(): boolean
}

export class RecurringQuestionRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async detect(options?: RecurringQuestionOptions): Promise<RecurringQuestionResults>
}
```

**Flow:**
1. Get open issues with `digest.category === 'question'`, filter to unanalyzed
2. Get ALL closed issues with digests as knowledge base
3. Batch candidates by `config.sync.recurringBatchSize`
4. For each batch: call LLM with candidates + closed issue KB
5. Persist `isRecurringQuestion`, `similarClosedIssues`, `suggestedResponse`, `recurringAnalyzedAt`
6. Return only issues where `isRecurring: true`

#### interactive.ts

```ts
type RecurringDecision = 'post-close' | 'post-open' | 'edit' | 'skip' | 'browser' | 'stop';

export class RecurringQuestionInteractiveUI {
  constructor(results: RecurringQuestionResults, config: Config)
  async present(): Promise<void>
}
```

**TUI flow:**

```
QUESTION 1 of 3 ─────────────────────────────────────────────
  #234  "How do I configure the timeout?"

  Similar closed issues:
    → #45  "Timeout configuration" — closed 8 months ago
    → #89  "Request timeout setting" — closed 5 months ago

  Suggested response:
  ┌─────────────────────────────────────────────────┐
  │ This has been answered before! Check out:        │
  │                                                  │
  │ - #45 covers timeout configuration in detail     │
  │ - #89 has additional context on request timeouts │
  │                                                  │
  │ Closing as answered — feel free to reopen if     │
  │ your question is different.                      │
  └─────────────────────────────────────────────────┘

? What do you want to do with #234?
❯ Post response + close issue
  Post response, leave open
  Edit response first
  Skip — not a recurring question
  Open in browser to compare
  Stop reviewing
```

**Decision handling:**
- `post-close`: Queue for GitHub comment + close as `not_planned`
- `post-open`: Queue for GitHub comment, leave open
- `edit`: `input()` prompt pre-filled with suggested response, then re-ask
- `skip`: Clear recurring analysis fields
- After loop: confirm batch → `github.addComment()`, optionally `github.closeIssue()`

#### index.ts

```ts
actionRegistry.register({
  id: 'recurring-questions',
  label: 'Recurring Questions',
  description: 'Find questions already answered in closed issues',
  icon: '🔁',

  getBadge(store) {
    const questions = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'question' && i.analysis.recurringAnalyzedAt === null);
    return questions.length > 0 ? `${questions.length} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const questions = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'question');
    const closedIssues = store.getIssues({ state: 'closed', hasDigest: true });
    if (questions.length === 0) return 'no open questions found';
    if (closedIssues.length === 0) return 'no closed issues to compare against';
    return true;
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

#### Tests

- Mock LLMService
- Test that only `question` category issues become candidates
- Test that closed issues form the knowledge base
- Test `isRecurring: false` still writes `recurringAnalyzedAt`
- Test skip clears analysis fields

---

## Phase 3 — Triage Intelligence

---

### ACTION: Priority Score

**Directory:** `src/actions/priority/`

#### prompt.ts

**Response schema:**
```ts
export const PriorityResponseSchema = z.object({
  priorities: z.array(z.object({
    number: z.number(),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    reason: z.string(),
    signals: z.array(z.string()),   // e.g. ["data loss mentioned", "3 users affected", "regression"]
  })),
});
```

**Prompt builder:** `buildPriorityPrompt(candidates: StoredIssue[]): string`

Prompt strategy:
- Feed issue digest + title + body (truncated) + labels + comment count (add `commentCount` to `StoredIssueSchema` — see note below) + reactions count
- Priority rubric embedded in prompt:
  - `critical`: data loss, security vulnerability, production down, affects majority of users
  - `high`: regression, broken core functionality, affects significant user segment
  - `medium`: non-critical bug, UX issue, affects subset of users
  - `low`: enhancement, nice-to-have, cosmetic, edge case
- Signals must cite specific evidence from the issue text

**Store schema note:** Add `commentCount: z.number().default(0)` and `reactions: z.number().default(0)` to `StoredIssueSchema`. Populate during `fetchAllIssues` / `fetchIssuesSince` from the GitHub API response (`comments` and `reactions.total_count` fields).

#### runner.ts

```ts
export interface PriorityOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface PrioritizedIssue {
  number: number;
  title: string;
  htmlUrl: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  signals: string[];
}

export class PriorityResults {
  constructor(
    public readonly items: PrioritizedIssue[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): PriorityResults
  get isEmpty(): boolean
}

export class PriorityRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async analyze(options?: PriorityOptions): Promise<PriorityResults>
}
```

**Flow:**
1. Get digested issues, filter to `priorityAnalyzedAt === null` unless recheck
2. Batch by `config.sync.priorityBatchSize`
3. For each batch: call LLM, persist `priority`, `priorityReason`, `priorityAnalyzedAt`
4. Return all items sorted by priority (critical first)

#### interactive.ts

```ts
type PriorityDecision = 'accept' | 'override' | 'skip' | 'stop';

export class PriorityInteractiveUI {
  constructor(results: PriorityResults, config: Config)
  async present(): Promise<void>
}
```

**TUI flow — shows a ranked summary table first, then per-issue review:**

```
Priority Analysis Complete
─────────────────────────────────────────────────

  ████ critical  #89   Data loss when migrating — users report records deleted
                       Signals: data loss mentioned, 3 users report same issue
  ████ high      #12   Login broken on Safari iOS — affects ~15% of mobile users
                       Signals: broken core feature, mobile-specific regression
  ███  high      #67   Performance regression in v2.3 — 3x slower than v2.2
                       Signals: regression, performance degradation with metrics
  ██   medium    #34   Dropdown z-index overlaps modal on small screens
                       Signals: UI issue, edge case on specific screen size
  █    low       #201  Add dark mode option
                       Signals: enhancement request, no current impact

? Review each priority assignment?
❯ Yes, review one by one
  Accept all as-is
  Accept all + apply priority labels on GitHub
```

If "review one by one":
```
ISSUE 1 of 5 ─────────────────────────────────────────────
  #89  "Data loss when migrating"
  AI priority: critical
  Reason: Users report complete data loss during migration
  Signals: data loss mentioned, 3 users report same issue

? Accept this priority?
❯ Accept (critical)
  Override — set different priority
  Skip — don't assign priority
  Stop reviewing
```

If "Override": show `select()` with `critical / high / medium / low`.

After review loop: "Apply priority labels to N issue(s) on GitHub?" → `github.addLabel(n, 'priority: critical')` etc.

#### index.ts

```ts
actionRegistry.register({
  id: 'priority',
  label: 'Priority Score',
  description: 'Assign priority levels to open issues based on impact signals',
  icon: '📊',

  getBadge(store) {
    const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.priorityAnalyzedAt === null).length;
    return unanalyzed > 0 ? `${unanalyzed} unscored` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    return withDigest.length > 0 ? true : 'no issues with digest';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

#### Tests

- Test priority distribution (mock LLM returns mixed priorities)
- Test sort order (critical → high → medium → low)
- Test override persists correctly
- Test skip clears priority fields

---

### ACTION: Good First Issue Tagging

**Directory:** `src/actions/good-first-issue/`

#### prompt.ts

**Response schema:**
```ts
export const GoodFirstIssueResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    isGoodFirstIssue: z.boolean(),
    reason: z.string(),
    codeHint: z.string(),   // e.g. "Look at src/auth/ — the middleware chain is well-documented"
    estimatedComplexity: z.enum(['trivial', 'small', 'medium']),
  })),
});
```

**Prompt builder:** `buildGoodFirstIssuePrompt(candidates: StoredIssue[]): string`

Prompt strategy:
- Feed issue digest + title + body
- Criteria: self-contained scope, clear acceptance criteria, no architectural decisions needed, < 1 day for a newcomer
- Exclude issues already labeled `good first issue`
- If suitable, provide a hint about where to look in the codebase (from digest's `affectedArea`)
- Reject if issue requires deep understanding of multiple systems

#### runner.ts

```ts
export interface GoodFirstIssueOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface GoodFirstIssueSuggestion {
  number: number;
  title: string;
  htmlUrl: string;
  reason: string;
  codeHint: string;
  estimatedComplexity: 'trivial' | 'small' | 'medium';
}

export class GoodFirstIssueResults {
  constructor(
    public readonly suggestions: GoodFirstIssueSuggestion[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): GoodFirstIssueResults
  get isEmpty(): boolean
}

export class GoodFirstIssueRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async analyze(options?: GoodFirstIssueOptions): Promise<GoodFirstIssueResults>
}
```

**Flow:**
1. Get open digested issues, filter out those already labeled `good first issue`
2. Filter to unanalyzed unless recheck
3. Batch and call LLM
4. Persist `isGoodFirstIssue`, `goodFirstIssueReason`, `goodFirstIssueHint`, `goodFirstIssueAnalyzedAt`
5. Return only issues where `isGoodFirstIssue: true`

#### interactive.ts

**TUI flow:**

```
Good First Issue Candidates
─────────────────────────────────────────────────
  Found 4 issues suitable for new contributors.

ISSUE 1 of 4 ─────────────────────────────────────────────
  #156  "Add input validation for email field"
  Complexity: small
  Reason: Self-contained validation logic, clear acceptance criteria
  Hint: Look at src/forms/ — validation utils already exist for other fields

? What do you want to do with #156?
❯ Add 'good first issue' label + post hint comment
  Add 'good first issue' label only
  Skip — not suitable for newcomers
  Open in browser
  Stop reviewing
```

**Decision handling:**
- `label-comment`: Queue label + hint comment
- `label-only`: Queue label only
- `skip`: Clear analysis
- After loop: confirm batch → `github.addLabel(n, 'good first issue')`, optionally `github.addComment(n, hint)`

#### index.ts

```ts
actionRegistry.register({
  id: 'good-first-issue',
  label: 'Good First Issues',
  description: 'Tag issues suitable for new contributors',
  icon: '🌱',
  // getBadge: count open issues without goodFirstIssueAnalyzedAt
  // isAvailable: needs digested open issues
});
```

---

### ACTION: Security Triage

**Directory:** `src/actions/security/`

#### prompt.ts

**Response schema:**
```ts
export const SecurityResponseSchema = z.object({
  findings: z.array(z.object({
    number: z.number(),
    isSecurityRelated: z.boolean(),
    confidence: z.number().min(0).max(1),
    category: z.string(),     // e.g. "authentication bypass", "injection", "data exposure"
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    explanation: z.string(),
  })),
});
```

**Prompt builder:** `buildSecurityPrompt(candidates: StoredIssue[]): string`

Prompt strategy:
- Feed full issue body (not just digest) since security details are often subtle
- Detection categories: auth bypass, session hijacking, privilege escalation, injection (SQL/command/path), data exposure, credential logging, dependency vulnerabilities
- Minimum confidence: 0.70 (lower than duplicates — false positives are acceptable for security)
- If not security-related, set `isSecurityRelated: false`

#### runner.ts

```ts
export class SecurityResults {
  constructor(
    public readonly findings: SecurityFinding[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
}

export class SecurityRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async scan(options?: SecurityOptions): Promise<SecurityResults>
}
```

**Flow:**
1. Get ALL digested issues (not just bugs — security issues hide in feature requests and questions)
2. Filter to unanalyzed unless recheck
3. Batch by `config.sync.securityBatchSize`
4. Persist `securityFlag`, `securityConfidence`, `securityCategory`, `securityAnalyzedAt`
5. Return only findings where `isSecurityRelated: true`

#### interactive.ts

**TUI flow — security uses a different pattern: alert-first, review-second:**

```
⚠  SECURITY SCAN COMPLETE
═══════════════════════════════════════════════════

  2 issues may contain security implications:

  #178  "API key visible in error response"
        Category: data exposure
        Confidence: 94%    Severity: high

  #203  "Admin panel accessible without login"
        Category: authentication bypass
        Confidence: 88%    Severity: critical

? How do you want to handle these?
❯ Review each finding
  Add 'security' label to all
  Skip all — no action needed
```

If "Review each finding", per-issue:
```
? What do you want to do with #178?
❯ Add 'security' label on GitHub
  Add 'security' label + post private note comment
  Skip — not a security issue
  Open in browser
```

No close option — security issues are never auto-closed.

#### index.ts

```ts
actionRegistry.register({
  id: 'security',
  label: 'Security Triage',
  description: 'Scan all issues for potential security implications',
  icon: '🔒',
  // getBadge: count issues without securityAnalyzedAt
  // isAvailable: needs digested issues
});
```

---

## Phase 4 — Release Workflow

---

### ACTION: Release Notes Generator

**Directory:** `src/actions/release-notes/`

This action is different from others — it doesn't analyze individual issues. It synthesizes information from closed issues into a release document.

#### prompt.ts

**Response schema:**
```ts
export const ReleaseNotesResponseSchema = z.object({
  sections: z.array(z.object({
    heading: z.string(),           // e.g. "Bug Fixes", "New Features", "Performance"
    emoji: z.string(),             // e.g. "🐛", "✨", "⚡"
    items: z.array(z.object({
      description: z.string(),     // Clean prose, not issue title verbatim
      issues: z.array(z.number()), // Referenced issue numbers
    })),
  })),
  contributors: z.array(z.object({
    username: z.string(),
    isFirstTime: z.boolean(),
  })),
});
```

**Prompt builder:** `buildReleaseNotesPrompt(issues: StoredIssue[], versionTag?: string): string`

Prompt strategy:
- Feed closed issue digests (not raw bodies — digest ensures clean language)
- Instructions: group by category, write clean prose descriptions, merge related issues into single entries
- Section ordering: Security > Bug Fixes > New Features > Performance > Other
- Contributor list from issue `author` field. First-time = author not seen in any earlier closed issue

#### runner.ts

```ts
export interface ReleaseNotesOptions {
  since?: string;        // ISO date — issues closed after this date
  until?: string;        // ISO date — issues closed before this date
  issues?: number[];     // Specific issue numbers
}

export class ReleaseNotesResult {
  constructor(
    public readonly markdown: string,
    public readonly issueCount: number,
  ) {}
}

export class ReleaseNotesRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async generate(options: ReleaseNotesOptions): Promise<ReleaseNotesResult>
}
```

**Flow:**
1. Select issues based on options:
   - `since`/`until`: filter by `updatedAt` (proxy for close date) on closed issues
   - `issues`: specific numbers
   - Default: all closed issues since last sync
2. Call LLM with selected issue digests
3. Build markdown from response sections
4. Return formatted markdown string

#### interactive.ts

**TUI flow — this is selection-first, then generation:**

```
Release Notes Generator
─────────────────────────────────────────────────

? How do you want to select issues for this release?
❯ By date range
  All closed since last release notes
  Pick specific issues

[If "By date range":]
? Start date (YYYY-MM-DD): 2025-02-01
? End date (YYYY-MM-DD): 2025-03-15

Found 23 closed issues in this range.
Generating release notes...

═══════════════════════════════════════════════════
## v2.4.0 — 2025-03-15

### 🐛 Bug Fixes
- Fix cart total not updating after discount code (#123, #156)
- Resolve Safari iOS login crash (#89)
...
═══════════════════════════════════════════════════

? What next?
❯ Copy to clipboard
  Save to file (CHANGELOG.md)
  Edit before saving
  Regenerate
  Done
```

**Decision handling:**
- `copy`: Use `clipboardy` or `pbcopy`/`xclip` via child_process
- `save`: Write to `CHANGELOG.md` (prepend to existing) or user-specified path
- `edit`: Show in `editor()` prompt (opens $EDITOR)
- `regenerate`: Re-run LLM with same issues

#### index.ts

```ts
actionRegistry.register({
  id: 'release-notes',
  label: 'Release Notes',
  description: 'Generate structured release notes from closed issues',
  icon: '📋',

  getBadge(store) {
    const closed = store.getIssues({ state: 'closed', hasDigest: true });
    return closed.length > 0 ? `${closed.length} closed issues` : 'no closed issues';
  },

  isAvailable(store) {
    const closed = store.getIssues({ state: 'closed', hasDigest: true });
    return closed.length > 0 ? true : 'no closed issues with digest — sync with --include-closed';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

**Config note:** Requires `includeClosed: true` in config to have closed issues in the store. The `isAvailable` check tells the user to sync with `--include-closed` if no closed issues exist.

---

### ACTION: Milestone Planner

**Directory:** `src/actions/milestone-planner/`

#### prompt.ts

**Response schema:**
```ts
export const MilestonePlanResponseSchema = z.object({
  milestones: z.array(z.object({
    name: z.string(),          // e.g. "v2.5 — Auth Overhaul"
    theme: z.string(),         // e.g. "Authentication and security improvements"
    issues: z.array(z.number()),
    effort: z.enum(['small', 'medium', 'large']),
    rationale: z.string(),
  })),
  unassigned: z.array(z.number()),  // Issues that don't fit any milestone
});
```

**Prompt builder:** `buildMilestonePlanPrompt(issues: StoredIssue[]): string`

Prompt strategy:
- Feed all open digested issues with their priority (if analyzed)
- Instructions: group into 2-4 logical milestones based on theme clustering, priority, and dependencies
- Critical/high priority issues go first
- Each milestone should be a coherent, shippable unit
- Unassigned issues are ones that don't fit any theme

#### runner.ts

```ts
export interface MilestoneSuggestion {
  name: string;
  theme: string;
  issues: Array<{ number: number; title: string; priority?: string }>;
  effort: 'small' | 'medium' | 'large';
  rationale: string;
}

export class MilestonePlanResults {
  constructor(
    public readonly milestones: MilestoneSuggestion[],
    public readonly unassigned: Array<{ number: number; title: string }>,
    public readonly store: IssueStore,
  ) {}
}

export class MilestonePlanRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async plan(): Promise<MilestonePlanResults>
}
```

**Flow:**
1. Get all open digested issues
2. Single LLM call (not batched — needs holistic view of all issues)
3. Resolve issue numbers to titles for display
4. Return milestone suggestions

No store persistence — this is a planning tool, not an analysis. Results are ephemeral.

#### interactive.ts

**TUI flow:**

```
Milestone Planner
─────────────────────────────────────────────────

Analyzing 45 open issues for theme clustering...

═══════════════════════════════════════════════════

MILESTONE 1: v-next — Auth & Security
  Theme: Authentication and security improvements
  Effort: medium (estimated 2-3 weeks)
  ─────────────────────────────────────────────
  #89  critical  Login broken on Safari iOS
  #178 high      API key visible in error response
  #203 high      Admin panel accessible without login
  #34  medium    Session timeout not configurable

MILESTONE 2: v-next+1 — Performance
  Theme: Speed and resource optimization
  Effort: large (estimated 4-6 weeks)
  ─────────────────────────────────────────────
  #67  high      Performance regression in v2.3
  #145 medium    Initial bundle size too large
  ...

UNASSIGNED (8 issues)
  #201 low   Add dark mode option
  ...

═══════════════════════════════════════════════════

? What next?
❯ Save plan to file
  Regenerate with different grouping
  Done
```

No GitHub operations — this is advisory only.

#### index.ts

```ts
actionRegistry.register({
  id: 'milestone-planner',
  label: 'Milestone Planner',
  description: 'Group open issues into logical release milestones',
  icon: '🗺️',

  getBadge(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    return `${open.length} open issues`;
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    return open.length >= 3 ? true : 'need at least 3 open issues for meaningful grouping';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

---

## Phase 5 — Community Health

---

### ACTION: Stale Issue Cleanup

**Directory:** `src/actions/stale/`

#### prompt.ts

**Response schema:**
```ts
export const StaleAnalysisResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    action: z.enum(['close-resolved', 'close-wontfix', 'label-stale', 'keep-open']),
    reason: z.string(),
    draftComment: z.string(),   // Comment to post before closing/labeling
  })),
});
```

**Prompt builder:** `buildStaleAnalysisPrompt(candidates: StoredIssue[], recentClosedIssues: StoredIssue[]): string`

Prompt strategy:
- Candidates: open issues with no activity for N days (`config.sync.staleDaysThreshold`)
- Also feed recently closed issues (for cross-referencing whether bug was fixed)
- Instructions per category:
  - Bug: was it fixed by a subsequent issue/PR? → `close-resolved`
  - Question: was it answered in comments? → `close-resolved`
  - Feature: superseded by different implementation? → `close-wontfix`
  - Otherwise: still relevant? → `keep-open` or `label-stale`
- Draft comment should be polite and explain why

**Staleness detection:** Compare `updatedAt` against current date. Issues where `daysSinceUpdate >= config.sync.staleDaysThreshold` are candidates. Compute in runner, not prompt.

#### runner.ts

```ts
export interface StaleOptions {
  daysThreshold?: number;   // Override config default
  recheck?: boolean;
  dryRun?: boolean;
}

export interface StaleIssueResult {
  number: number;
  title: string;
  htmlUrl: string;
  daysSinceUpdate: number;
  action: 'close-resolved' | 'close-wontfix' | 'label-stale' | 'keep-open';
  reason: string;
  draftComment: string;
}

export class StaleResults {
  constructor(
    public readonly items: StaleIssueResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): StaleResults
  get isEmpty(): boolean
}

export class StaleRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async analyze(options?: StaleOptions): Promise<StaleResults>
}
```

**Flow:**
1. Get open digested issues
2. Filter to stale: `daysSince(issue.updatedAt) >= threshold`
3. Filter to unanalyzed unless recheck
4. Get closed issues as context for cross-referencing
5. Batch and call LLM
6. Persist `staleAction`, `staleReason`, `staleAnalyzedAt`
7. Return items grouped by action

#### interactive.ts

**TUI flow — grouped by suggested action:**

```
Stale Issue Cleanup
─────────────────────────────────────────────────
  Found 12 stale issues (no activity for 90+ days)

  Suggested actions:
    Close as resolved: 3
    Close as won't fix: 2
    Add 'stale' label:  5
    Keep open:          2

? How do you want to review?
❯ Review one by one
  Accept all suggestions
  Only review close suggestions
```

Per-issue (for close suggestions):
```
STALE ISSUE 1 of 5 ─────────────────────────────────────────
  #45  "Timeout not configurable" — 142 days inactive
  Suggested: close as resolved
  Reason: #189 (closed 3 months ago) added timeout configuration

  Draft comment:
  ┌─────────────────────────────────────────────────┐
  │ This was addressed in #189 which added timeout   │
  │ configuration support. Closing as resolved —     │
  │ please reopen if the issue persists.             │
  └─────────────────────────────────────────────────┘

? What do you want to do with #45?
❯ Close with comment
  Add 'stale' label + warning comment (will close in 14 days)
  Keep open — still relevant
  Edit comment first
  Open in browser
  Stop reviewing
```

**Decision handling:**
- `close`: Queue `github.addComment()` + `github.closeIssue()`
- `stale-label`: Queue `github.addLabel(n, 'stale')` + comment with "will close in 14 days"
- `keep`: Clear stale analysis
- After loop: confirm batch

#### index.ts

```ts
actionRegistry.register({
  id: 'stale',
  label: 'Stale Issue Cleanup',
  description: 'Review and resolve issues with no recent activity',
  icon: '🧹',

  getBadge(store) {
    const threshold = 90; // days — could read from config but badge is simple
    const now = Date.now();
    const stale = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => (now - new Date(i.updatedAt).getTime()) / 86400000 >= threshold);
    return stale.length > 0 ? `${stale.length} stale` : 'no stale issues';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    return open.length > 0 ? true : 'no open issues';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

---

### ACTION: Contributor Welcome

**Directory:** `src/actions/contributor-welcome/`

This action is different — it doesn't batch-analyze issues. It identifies first-time contributors and drafts personalized welcome comments.

#### prompt.ts

**Response schema:**
```ts
export const WelcomeResponseSchema = z.object({
  comments: z.array(z.object({
    number: z.number(),
    welcomeComment: z.string(),   // Full ready-to-post comment
  })),
});
```

**Prompt builder:** `buildWelcomePrompt(issues: StoredIssue[], hasContributing: boolean): string`

Prompt strategy:
- Feed issue digest + title + category for each first-timer's issue
- Instructions: draft a warm, personalized welcome
  - Thank by name (from `author` field)
  - Explain contribution process (link to CONTRIBUTING.md if `hasContributing` is true)
  - Set response time expectations
  - If bug: confirm receipt, ask for missing info in same message
  - If feature: explain the decision process
- Not a generic template — reference what they filed

#### runner.ts

```ts
export interface ContributorWelcomeOptions {
  dryRun?: boolean;
}

export interface WelcomeCandidate {
  number: number;
  title: string;
  htmlUrl: string;
  author: string;
  category: string;
  welcomeComment: string;
}

export class ContributorWelcomeResults {
  constructor(
    public readonly candidates: WelcomeCandidate[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): ContributorWelcomeResults
  get isEmpty(): boolean
}

export class ContributorWelcomeRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async detect(options?: ContributorWelcomeOptions): Promise<ContributorWelcomeResults>
}
```

**Flow:**
1. Get all issues, build a set of known authors (all issues, all states)
2. Find open issues where the author appears only once in the full issue list (first-time contributor)
3. Filter out issues that already have comments (the contributor was already welcomed) — requires `commentCount > 0` field
4. Call LLM with these issues to generate welcome comments
5. No store persistence needed — this is a one-shot action. Track via `commentCount` or a simple flag.

**Alternative for tracking:** Add `welcomeCommentPostedAt: z.string().nullable().default(null)` to analysis schema.

#### interactive.ts

**TUI flow:**

```
Contributor Welcome
─────────────────────────────────────────────────
  Found 3 first-time contributors with no welcome yet.

CONTRIBUTOR 1 of 3 ─────────────────────────────────────────
  #234 by @alice — "Fix typo in auth module" (bug)

  Draft welcome:
  ┌─────────────────────────────────────────────────┐
  │ Welcome @alice, and thanks for reporting this!   │
  │                                                  │
  │ We've noted the typo in the auth module. A       │
  │ maintainer will take a look soon — typical       │
  │ response time is 2-3 business days.              │
  │                                                  │
  │ If you'd like to fix it yourself, check out our  │
  │ [Contributing Guide](CONTRIBUTING.md).           │
  └─────────────────────────────────────────────────┘

? What do you want to do?
❯ Post welcome comment
  Edit comment first
  Skip — don't welcome
  Stop reviewing
```

After loop: confirm batch → `github.addComment()` for each.

#### index.ts

```ts
actionRegistry.register({
  id: 'contributor-welcome',
  label: 'Welcome Contributors',
  description: 'Post personalized welcome comments for first-time contributors',
  icon: '👋',

  getBadge(store) {
    // Count first-time authors with open issues
    const allIssues = store.getIssues({ state: 'all' });
    const authorCounts = new Map<string, number>();
    for (const issue of allIssues) {
      authorCounts.set(issue.author, (authorCounts.get(issue.author) ?? 0) + 1);
    }
    const firstTimers = store.getIssues({ state: 'open' })
      .filter(i => authorCounts.get(i.author) === 1);
    return firstTimers.length > 0 ? `${firstTimers.length} new contributors` : 'none pending';
  },

  isAvailable(store) {
    return store.getIssues({ state: 'open' }).length > 0 ? true : 'no open issues';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

---

### ACTION: Issue Quality Check

**Directory:** `src/actions/quality/`

#### prompt.ts

**Response schema:**
```ts
export const QualityCheckResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    quality: z.enum(['spam', 'vague', 'test', 'wrong-language', 'ok']),
    reason: z.string(),
    suggestedLabel: z.string().nullable(),   // 'spam', 'needs-info', 'invalid', or null
  })),
});
```

**Prompt builder:** `buildQualityCheckPrompt(candidates: StoredIssue[], repoLanguage?: string): string`

Prompt strategy:
- Feed issue title + body (full, not digest — need to see original quality)
- Detection categories:
  - `spam`: promotional, unrelated, SEO garbage
  - `vague`: "it doesn't work" with no actionable detail
  - `test`: test/accidental submissions ("asdf", "test issue", empty body)
  - `wrong-language`: if repo specifies a language requirement (from config)
  - `ok`: legitimate issue
- For `vague` issues, suggest `needs-info` label. For `spam`/`test`, suggest `invalid`

#### runner.ts

```ts
export interface QualityOptions {
  recheck?: boolean;
  dryRun?: boolean;
}

export interface QualityFlagged {
  number: number;
  title: string;
  htmlUrl: string;
  quality: 'spam' | 'vague' | 'test' | 'wrong-language';
  reason: string;
  suggestedLabel: string;
}

export class QualityResults {
  constructor(
    public readonly flagged: QualityFlagged[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}
  static empty(message: string): QualityResults
  get isEmpty(): boolean
}

export class QualityRunner {
  constructor(store: IssueStore, config: Config, llmService?: LLMService)
  async check(options?: QualityOptions): Promise<QualityResults>
}
```

**Flow:**
1. Get open issues (use raw title/body, not just digest)
2. Filter to unanalyzed (`qualityAnalyzedAt === null`) unless recheck
3. Batch and call LLM
4. Persist `qualityFlag`, `qualityAnalyzedAt`
5. Return only non-`ok` issues

#### interactive.ts

**TUI flow — grouped by quality flag:**

```
Issue Quality Check
─────────────────────────────────────────────────
  Scanned 45 open issues.

  Flagged:
    Spam:           2
    Vague:          5
    Test/accidental: 1
    Wrong language:  0

? How do you want to review?
❯ Review all flagged issues
  Only review spam
  Skip — no action needed
```

Per-issue:
```
FLAGGED 1 of 8 ─────────────────────────────────────────
  #301  "Buy cheap watches online!!!" — flagged as spam
  Reason: Promotional content unrelated to the project

? What do you want to do with #301?
❯ Add 'invalid' label on GitHub
  Add 'invalid' label + close issue
  Skip — legitimate issue
  Open in browser
  Stop reviewing
```

For `vague` issues:
```
? What do you want to do with #312?
❯ Add 'needs-info' label + post info request
  Skip — has enough info
  Open in browser
```

Note: never auto-close. Flagging only. Maintainer confirms every close.

#### index.ts

```ts
actionRegistry.register({
  id: 'quality',
  label: 'Issue Quality Check',
  description: 'Flag spam, vague, and low-quality submissions',
  icon: '🔎',

  getBadge(store) {
    const unchecked = store.getIssues({ state: 'open' })
      .filter(i => i.analysis.qualityAnalyzedAt === null).length;
    return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
  },

  isAvailable(store) {
    return store.getIssues({ state: 'open' }).length > 0 ? true : 'no open issues';
  },

  async run({ store, config, interactive }) { /* ... */ },
});
```

---

## Hub Menu Layout

After all actions are registered, the hub menu shows:

```
   ____
  / ___|___ ______ _ _ __
 | |   / _ \_  / _` | '__|
 | |__|  __// / (_| | |
  \____\___/___\__,_|_|    AI-powered GitHub issue management

 ┌─ open-mercato/core ─────────────────────────────────┐
 │  Open: 142  Closed: 89  Last sync: 2 hours ago      │
 │  Digests: 142/142 (100%)                             │
 └──────────────────────────────────────────────────────┘

? What would you like to do?
  🔍  Find Duplicates              45 unanalyzed
  ❓  Request Missing Info          12 unchecked bugs
  🏷️  Auto-Label Issues            38 unlabeled
  🔁  Recurring Questions           6 unchecked
  ────────────────────────────────────────────
  📊  Priority Score               45 unscored
  🌱  Good First Issues            45 unanalyzed
  🔒  Security Triage              45 unscanned
  ────────────────────────────────────────────
  📋  Release Notes                89 closed issues
  🗺️  Milestone Planner            142 open issues
  ────────────────────────────────────────────
  🧹  Stale Issue Cleanup          8 stale
  👋  Welcome Contributors         3 new contributors
  🔎  Issue Quality Check          12 unchecked
  ────────────────────────────────────────────
  🔄  Sync with GitHub
  ────────────────────────────────────────────
  ✕   Exit
```

To achieve separators between phases, update `buildChoices()` in `hub.ts` to group actions by a `phase` or `group` property. Extend `ActionDefinition`:

```ts
export interface ActionDefinition {
  // ... existing fields ...
  /** Menu grouping (used for separator placement in hub) */
  group: 'triage' | 'intelligence' | 'release' | 'community';
}
```

Or simpler: add separators between known action ID groups in `buildChoices()`.

---

## Side-Effect Registration Order (`src/index.ts`)

```ts
// Phase 1
import './actions/duplicates/index.js';

// Phase 2
import './actions/missing-info/index.js';
import './actions/auto-label/index.js';
import './actions/recurring-questions/index.js';

// Phase 3
import './actions/priority/index.js';
import './actions/good-first-issue/index.js';
import './actions/security/index.js';

// Phase 4
import './actions/release-notes/index.js';
import './actions/milestone-planner/index.js';

// Phase 5
import './actions/stale/index.js';
import './actions/contributor-welcome/index.js';
import './actions/quality/index.js';
```

---

## Implementation Order

Build in this order (each step compilable + testable):

1. **Shared infrastructure** — schema extensions, config extensions, GitHub service methods, `LLMService.analyze()` generic method
2. **Missing Info** — highest impact Phase 2 action (prompt → runner → tests → interactive → registration)
3. **Auto-Label** — requires `github.fetchRepoLabels()` + `github.setLabels()`
4. **Recurring Questions** — requires closed issues in store
5. **Priority** — requires `commentCount`/`reactions` on stored issues
6. **Security** — follows same pattern, can use existing fields
7. **Good First Issue** — simple analysis, builds on priority data
8. **Quality Check** — simple analysis, uses raw bodies
9. **Stale Cleanup** — requires date math, cross-references closed issues
10. **Contributor Welcome** — unique pattern (author analysis)
11. **Release Notes** — different pattern (synthesis, not analysis)
12. **Milestone Planner** — different pattern (planning, not persistence)

---

## Test Strategy

Each action gets `tests/actions/{name}/runner.test.ts` with:

1. **Mock LLMService** — `vi.fn().mockResolvedValue()` returning shaped responses
2. **In-memory store** — temp dir + `IssueStore.init()`
3. **Test cases:**
   - Happy path: mock returns results, verify store persistence
   - Empty candidates: early return with message
   - Recheck flag: all issues sent regardless of `analyzedAt`
   - Batch boundaries: verify multiple batches processed
   - Dry run: verify store NOT saved
   - Edge cases per action (e.g., no closed issues for recurring questions)

Interactive UIs are not unit-tested — they are tested manually via the hub.
