# GitHub Issue Manager CLI — Specification v3

---

## Real-Life Use Case Validation

Before any architecture decision, these are the concrete scenarios the tool must serve well. Every design choice is justified against at least one of these.

### Use Case A — The Overwhelmed Maintainer
> "I have 180 open issues. I haven't touched them in 3 months. I don't know where to start."

Needs: fast overview, duplicate cleanup first (reduces noise immediately), then priority view to know what to actually fix.
Flow: `init` → interactive menu → **Find Duplicates** → review & close dupes → feel in control again.

### Use Case B — The New Issue Just Filed
> "Someone just filed issue #201. I think I've seen this before but I can't find it."

Needs: pull the new issue in, instantly check if it's a dupe, without re-running analysis on 180 old issues.
Flow: `sync` → interactive menu → **Find Duplicates** (only runs on new issues) → see match immediately.

### Use Case C — The Weekly Triage Session
> "Every Monday I spend 30 min on issues. I want to see what changed, deal with dupes, then know what to work on."

Needs: `sync` shows what's new, actions run incrementally (only on what changed), report tells the story.
Flow: `sync` → status shows "3 new, 2 updated" → menu shows "(3 unanalyzed)" badge → run duplicates → run priority.

### Use Case D — The CI Pipeline
> "I want this to run on a schedule and post a report, no human in the loop."

Needs: every command must be fully non-interactive when flags are provided. Interactive UI is layered on top, not baked in.
Flow: `issue-manager sync && issue-manager duplicates --apply --no-interactive`

### What These Cases Reject From v2
- ❌ A single `analyze` command that does everything — too slow, not incremental (UC-B fails)
- ❌ Actions that re-fetch GitHub every run — too slow for UC-C, hits rate limits
- ❌ Requiring `--format json` to get machine-readable output — UC-D needs `--no-interactive` to be enough
- ✅ Local store as source of truth — all four cases work offline after init
- ✅ Action badges showing pending work — UC-C user sees "(3 unanalyzed)" without running anything
- ✅ Interactive-by-default, scriptable-by-flag — UC-D uses flags, UC-A uses the menu

---

## Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x | Type safety, matches Open Mercato stack |
| Runtime | Node.js 20+ | LTS, native fetch, ESM support |
| CLI entry | Commander.js | Non-interactive commands + subcommand routing |
| Interactive UI | `@inquirer/prompts` | Arrow-key menus, confirmations, checkboxes. ESM-native, no React needed |
| Spinners | `ora` | Clean async progress with stream-safe API |
| Styling | `chalk` v5 | Colors + bold. ESM-native |
| Tables | `cli-table3` | Aligned columns for issue lists |
| Boxes | `boxen` | Status header and summary cards |
| GitHub API | `@octokit/rest` | Official, typed |
| LLM | `@anthropic-ai/sdk` | Streaming + typed |
| Store | JSON + atomic `fs/promises` write | No database dependency |
| Config | `cosmiconfig` | `.issuemanagerrc.json` auto-discovery |
| Validation | `zod` | Config + LLM response schemas |
| Hashing | Node `crypto` (built-in) | Content change detection |
| Testing | `vitest` | Fast, ESM-native |

**Why `@inquirer/prompts` over `ink`:** Ink (React in terminal) is powerful but heavy and creates complexity for something this straightforward. Inquirer gives arrow-key selection, confirmations, and multi-select with zero extra conceptual overhead. It also degrades gracefully in non-TTY environments (piped output).

---

## Repository Structure

```
github-issue-manager/
├── src/
│   ├── index.ts                        # Entry: Commander setup + interactive hub if no args
│   │
│   ├── ui/
│   │   ├── hub.ts                      # Interactive action selection menu (the main UX)
│   │   ├── status.ts                   # Status header box renderer
│   │   └── components/
│   │       ├── progress.ts             # Reusable progress bar wrapper around ora
│   │       ├── table.ts                # Reusable issue table renderer
│   │       └── confirm.ts              # Reusable Y/N confirmation prompt
│   │
│   ├── actions/
│   │   ├── registry.ts                 # Action plugin registry — the extensibility core
│   │   ├── action.interface.ts         # ActionDefinition interface
│   │   └── duplicates/
│   │       ├── index.ts                # Registers the duplicates action
│   │       ├── runner.ts               # Core detection logic
│   │       ├── interactive.ts          # Interactive result review UI
│   │       └── prompt.ts               # LLM prompt template
│   │
│   ├── commands/
│   │   ├── init.ts                     # `issue-manager init`
│   │   ├── sync.ts                     # `issue-manager sync`
│   │   ├── run.ts                      # `issue-manager run [action]` (non-interactive action runner)
│   │   └── status.ts                   # `issue-manager status`
│   │
│   ├── store/
│   │   ├── store.ts                    # Read/write/query/mutate store
│   │   └── store.model.ts              # Zod schemas for everything in store.json
│   │
│   ├── services/
│   │   ├── github.service.ts           # GitHub API interactions
│   │   └── llm.service.ts              # Claude API interactions (digest + action calls)
│   │
│   ├── models/
│   │   └── config.model.ts             # Zod config schema
│   │
│   └── utils/
│       ├── config.ts                   # cosmiconfig loader
│       ├── chunker.ts                  # Batch issues for LLM calls
│       ├── hash.ts                     # SHA-256 content hash
│       └── formatter.ts               # Shared render helpers (chalk, cli-table3)
│
├── tests/
│   ├── store/store.test.ts
│   ├── actions/duplicates/runner.test.ts
│   ├── services/github.service.test.ts
│   ├── services/llm.service.test.ts
│   └── utils/chunker.test.ts
│
├── .issuemanagerrc.example.json
├── .gitignore                          # includes .issue-store/
├── package.json
├── tsconfig.json
└── README.md
```

---

## The Interactive Hub — `src/ui/hub.ts`

Running `issue-manager` with no arguments launches the hub. This is the primary UX entry point.

### Visual Design

```
┌─────────────────────────────────────────────────────┐
│  🗂  Issue Manager                                   │
│  open-mercato/core                                   │
│                                                      │
│  143 open · 45 closed · synced 2 hours ago          │
│  Digested: 143/143 · Duplicates: last run 1 day ago │
└─────────────────────────────────────────────────────┘

? What would you like to do?
❯ 🔍  Find Duplicates            45 unanalyzed
  📊  View Report
  🔄  Sync with GitHub            last: 2h ago
  ──────────────────────────────
  ⚙   Settings
  ✕   Exit
```

Key UX decisions:
- **Badges are dynamic** — they read from the store at render time, show pending work counts
- **Unavailable actions are dimmed** — e.g. "Find Duplicates" shows "(run init first)" if no store exists, instead of failing after selection
- **The separator** between actions and utilities is a visual cue that the bottom items are meta, not work
- **No help text needed** — each action is self-describing with a badge

### Hub Implementation Sketch

```typescript
// src/ui/hub.ts
import { select, Separator } from '@inquirer/prompts';
import { renderStatusBox } from './status.ts';
import { actionRegistry } from '../actions/registry.ts';

export async function launchHub(store: Store | null, config: Config): Promise<void> {
  renderStatusBox(store);    // renders the boxen header

  const choices = buildChoices(store, config);

  const selected = await select({
    message: 'What would you like to do?',
    choices,
    pageSize: 10,
  });

  if (selected === 'exit') return;
  if (selected === 'sync') { await runSync(config); return; }

  // selected is an action id — look it up and run it
  const action = actionRegistry.get(selected);
  if (!action) return;

  await action.run({ store, config, interactive: true });
}

function buildChoices(store: Store | null, config: Config) {
  const actions = actionRegistry.getAll();
  return [
    ...actions.map(action => ({
      name: formatActionChoice(action, store),
      value: action.id,
      disabled: !store ? 'Run init first' : action.isAvailable(store) !== true
                          ? action.isAvailable(store)  // returns a reason string
                          : false,
    })),
    new Separator(),
    { name: '🔄  Sync with GitHub', value: 'sync' },
    new Separator(),
    { name: '✕   Exit', value: 'exit' },
  ];
}

function formatActionChoice(action: ActionDefinition, store: Store | null): string {
  const badge = store ? action.getBadge(store) : '';
  const padding = ' '.repeat(Math.max(0, 30 - action.label.length));
  return `${action.icon}  ${action.label}${padding}${badge ? chalk.dim(badge) : ''}`;
}
```

---

## Action Plugin Architecture — `src/actions/`

This is the extensibility core. Every analysis capability (find duplicates, assign priorities, detect stale issues, etc.) is an **Action** — a self-contained module that conforms to one interface.

### The Interface — `src/actions/action.interface.ts`

```typescript
export interface ActionDefinition {
  /** Unique machine identifier. Used as CLI argument: `issue-manager run duplicates` */
  id: string;

  /** Display name shown in the interactive menu */
  label: string;

  /** One-line description for --help output */
  description: string;

  /** Emoji icon shown in menu */
  icon: string;

  /**
   * Returns a short badge string shown next to the action in the menu.
   * e.g. "45 unanalyzed", "last run 3h ago", ""
   */
  getBadge(store: Store): string;

  /**
   * Returns true if the action can run, or a short reason string if it cannot.
   * e.g. "no issues with digest" or "run init first"
   */
  isAvailable(store: Store): true | string;

  /**
   * Run the action.
   * @param ctx.interactive  true = show prompts/confirmations, false = use defaults + flags
   * @param ctx.options      parsed CLI flags (from `issue-manager run duplicates --apply`)
   */
  run(ctx: ActionContext): Promise<void>;
}

export interface ActionContext {
  store: Store;
  config: Config;
  interactive: boolean;
  options: Record<string, unknown>;   // CLI flags passed to the action
}
```

### The Registry — `src/actions/registry.ts`

```typescript
class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    this.actions.set(action.id, action);
  }

  get(id: string): ActionDefinition | undefined {
    return this.actions.get(id);
  }

  getAll(): ActionDefinition[] {
    return [...this.actions.values()];
  }
}

export const actionRegistry = new ActionRegistry();
```

### Registering the Duplicates Action — `src/actions/duplicates/index.ts`

```typescript
import { actionRegistry } from '../registry.ts';
import { DuplicatesRunner } from './runner.ts';
import { DuplicatesInteractiveUI } from './interactive.ts';

actionRegistry.register({
  id: 'duplicates',
  label: 'Find Duplicates',
  description: 'Detect issues describing the same problem using AI',
  icon: '🔍',

  getBadge(store) {
    const unanalyzed = store.issues.filter(i =>
      i.state === 'open' && i.digest && i.analysis.duplicateOf === null
    ).length;
    return unanalyzed > 0 ? `${unanalyzed} unanalyzed` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.issues.filter(i => i.digest !== null).length;
    if (withDigest === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runner = new DuplicatesRunner(store, config);
    const results = await runner.detect(options);

    if (interactive) {
      await new DuplicatesInteractiveUI(results, config).present();
    } else {
      results.print(options.format as string ?? 'table');
    }
  },
});
```

### Adding Future Actions — as simple as creating a new folder

```
src/actions/
├── duplicates/       ← done in v1
├── priority/         ← future: assign critical/high/medium/low
├── stale/            ← future: find abandoned issues
├── cluster/          ← future: group by topic
└── suggest/          ← future: draft response for each issue
```

Each new action is a self-contained folder. No changes needed to `registry.ts`, `hub.ts`, or any existing code. The action registers itself, hub discovers it automatically.

---

## First Action: Find Duplicates — Deep Design

### The Interactive Review UX — `src/actions/duplicates/interactive.ts`

The most important UX decision: **after the LLM returns duplicate groups, don't just print and exit. Let the user review and decide what to do.**

```
🔍 Duplicate Detection Complete
───────────────────────────────────────────────────────
Found 8 duplicate groups across 143 open issues.

GROUP 1 of 8 ─────────────────────────────────────────

  ORIGINAL   #123  Cart total wrong after applying discount code  
  DUPLICATE  #156  Coupon doesn't update price in cart            
  
  Confidence: 97%
  Reason: Both describe cart total not recalculating after coupon
          application. #156 filed 3 weeks after #123.

? What do you want to do with #156?
❯ Mark as duplicate in store only (no GitHub change yet)
  Mark as duplicate + add 'duplicate' label on GitHub
  Skip — not a duplicate
  Open both in browser to compare
  Stop reviewing (keep decisions so far)
```

Each group gets reviewed in sequence. After all groups:

```
Review complete ───────────────────────────────────────

  Confirmed duplicates:  6
  Skipped:               2

? Apply 'duplicate' labels to all 6 confirmed duplicates on GitHub?
  ❯ Yes, apply labels now
    No, I'll do it later with `issue-manager run label`
    Show me what would be applied first (dry-run)
```

This flow means:
- The user is never surprised by automatic GitHub changes
- Each decision is explicit and reversible (store update vs GitHub update are separate)
- Skipping is always an option — the tool respects human judgment

### Detection Logic — `src/actions/duplicates/runner.ts`

```typescript
export class DuplicatesRunner {
  constructor(private store: Store, private config: Config) {}

  async detect(options: DuplicateOptions): Promise<DuplicateResults> {
    const allIssues = this.store.getIssues({ state: options.state ?? 'open', hasDigest: true });
    
    // Candidates = unanalyzed issues (or all if --recheck)
    const candidates = options.recheck
      ? allIssues
      : allIssues.filter(i => i.analysis.duplicateOf === null && i.analysis.analyzedAt === null);

    if (candidates.length === 0) {
      return DuplicateResults.empty('All issues already analyzed. Use --recheck to re-run.');
    }

    // All digests form the knowledge base the LLM compares against
    const knowledgeBase = allIssues;

    const spinner = ora(`Checking ${candidates.length} issues against ${knowledgeBase.length} total...`).start();

    // Split candidates into batches — knowledge base is always the full set
    const batches = chunkForDuplicates(candidates, this.config.sync.duplicateBatchSize);
    const allResults: DuplicateMatch[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;
      const batchResults = await llmService.detectDuplicates(batch, knowledgeBase);
      
      // Persist each batch to store immediately (crash-safe)
      for (const match of batchResults) {
        this.store.setAnalysis(match.number, {
          duplicateOf: match.duplicateOf,
          duplicateConfidence: match.confidence,
          duplicateReason: match.reason,
          analyzedAt: new Date().toISOString(),
        });
      }
      await this.store.save();
      allResults.push(...batchResults);
    }

    spinner.succeed(`Analysis complete — ${allResults.length} duplicates found`);
    return new DuplicateResults(allResults, this.store);
  }
}
```

### The LLM Prompt — `src/actions/duplicates/prompt.ts`

**Why digests work so well here:** The knowledge base prompt uses the compact digest format (~80 tokens/issue). With 200 issues that's ~16k tokens — fits comfortably in one call. Raw bodies would be ~120k tokens.

```typescript
export function buildDuplicatePrompt(
  candidates: StoredIssue[],
  knowledgeBase: StoredIssue[],
): string {
  return `
KNOWLEDGE BASE — all open issues (compact digest format):
${knowledgeBase.map(formatCompact).join('\n')}

CANDIDATES — check each of these against the knowledge base for duplicates:
${candidates.map(formatCompact).join('\n')}

An issue is a duplicate if it describes the same underlying problem or feature request,
even if the wording is completely different.

Rules:
- A candidate can only be a duplicate of a KNOWLEDGE BASE issue (not another candidate)
- The original is always the lower-numbered issue
- Only include candidates that ARE duplicates (omit non-duplicates entirely)
- Minimum confidence to include: 0.80
- If unsure, omit rather than guess

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "duplicates": [
    {
      "number": 456,
      "duplicateOf": 123,
      "confidence": 0.95,
      "reason": "One sentence explaining why these are the same issue"
    }
  ]
}
`.trim();
}

function formatCompact(issue: StoredIssue): string {
  const d = issue.digest!;
  return `#${issue.number} [${d.category}] ${d.affectedArea} | ${d.summary} | kw: ${d.keywords.join(', ')}`;
}
```

---

## Store Model — `src/store/store.model.ts`

Unchanged from v2 — the store design is solid. One addition: `analysis.analyzedAt` being `null` vs a timestamp is the canonical way to tell "has this issue been through the duplicates action" without a separate flag.

```typescript
// The key insight: each action writes to its own namespace in analysis
// analysis.duplicateOf     → set by duplicates action
// analysis.priority        → set by priority action (future)
// analysis.staleReason     → set by stale action (future)
// All start as null, actions fill them in independently

export const IssueAnalysisSchema = z.object({
  // Duplicates action
  duplicateOf:          z.number().nullable().default(null),
  duplicateConfidence:  z.number().min(0).max(1).nullable().default(null),
  duplicateReason:      z.string().nullable().default(null),
  duplicatesAnalyzedAt: z.string().nullable().default(null),

  // Priority action (future — included now so store schema is stable)
  priority:             z.enum(['critical','high','medium','low']).nullable().default(null),
  priorityReason:       z.string().nullable().default(null),
  priorityAnalyzedAt:   z.string().nullable().default(null),
});
```

Each action only writes to its own keys. Actions are fully independent — running `priority` doesn't touch `duplicateOf`, and vice versa. This means the store stays consistent even if actions are run in different orders.

---

## Commands — `src/commands/`

### `init` and `sync` — Unchanged From v2

The data-phase design from v2 is solid and validated by all four use cases. See v2 spec for full detail. Summary:
- `init`: full fetch + digest generation, saves to `.issue-store/store.json`
- `sync`: incremental update using `?since=` cursor + content hash change detection

### `run` — Non-Interactive Action Runner

This is the scriptable entry point for any registered action.

```
issue-manager run <action> [options]

Arguments:
  action          Action ID (e.g. duplicates, priority, stale)

Options:
  --state <s>     open|closed|all (default: open)
  --recheck       Re-analyze already-analyzed issues
  --apply         Apply results to GitHub immediately (no confirmation)
  --dry-run       Show what would happen, don't write anything
  --format <f>    table|json|markdown for output (default: table)
  --no-interactive  Force non-interactive mode even in a TTY
```

**Examples:**
```bash
# Interactive (default in TTY)
issue-manager run duplicates

# Fully automated (CI-safe)
issue-manager run duplicates --apply --no-interactive --format json > results.json

# Dry-run to preview
issue-manager run duplicates --dry-run
```

### `status` — Quick Store Overview

```
issue-manager status
```

Prints the same status box as the hub header, then exits. Useful for checking state in scripts.

---

## The Full `index.ts` Entry Point

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { launchHub } from './ui/hub.ts';
import { loadConfig } from './utils/config.ts';
import { IssueStore } from './store/store.ts';

// Register all actions (side-effect imports)
import './actions/duplicates/index.ts';
// future: import './actions/priority/index.ts';

const program = new Command()
  .name('issue-manager')
  .description('AI-powered GitHub issue management')
  .version('0.1.0');

program.command('init').description('Fetch all issues and generate digests')
  .option('-o, --owner <owner>')
  .option('-r, --repo <repo>')
  .option('-t, --token <token>')
  .option('--include-closed')
  .option('--no-digest', 'Skip LLM digest generation')
  .option('--force', 'Reinitialize even if store exists')
  .action(async (opts) => { /* ... */ });

program.command('sync').description('Pull new/updated issues from GitHub')
  .option('-t, --token <token>')
  .option('--include-closed')
  .action(async (opts) => { /* ... */ });

program.command('run <action>').description('Run an analysis action')
  .option('--state <state>', 'open|closed|all', 'open')
  .option('--recheck', 'Re-analyze already-analyzed issues')
  .option('--apply', 'Apply results to GitHub')
  .option('--dry-run')
  .option('--format <format>', 'table|json|markdown', 'table')
  .option('--no-interactive')
  .action(async (actionId, opts) => { /* look up from registry, run */ });

program.command('status').description('Show store summary')
  .action(async () => { /* render status box */ });

// No subcommand → launch interactive hub
program.action(async () => {
  const config = await loadConfig();
  const store = await IssueStore.loadOrNull(config.store.path);
  await launchHub(store, config);
});

program.parse();
```

---

## Package Configuration

### `package.json`

```json
{
  "name": "github-issue-manager",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "issue-manager": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc && chmod +x dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.27.0",
    "@inquirer/prompts": "^7.0.0",
    "@octokit/rest": "^21.0.0",
    "boxen": "^8.0.0",
    "chalk": "^5.0.0",
    "cli-table3": "^0.6.0",
    "commander": "^12.0.0",
    "cosmiconfig": "^9.0.0",
    "ora": "^8.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## Complete User Journey (All Four Use Cases Traced)

### Use Case A — Overwhelmed Maintainer

```bash
$ issue-manager init

✓ Fetching issues from open-mercato/core...
  ████████████████████ 143/143 issues fetched

✓ Generating digests...
  ████████████████████ 143/143 digested
  Categories: 71 bugs · 38 features · 14 docs · 20 other

✓ Store initialized at .issue-store/store.json
  Next: run 'issue-manager' to open the action menu

$ issue-manager

┌──────────────────────────────────────────────────┐
│  🗂  Issue Manager   open-mercato/core           │
│  143 open · synced just now                      │
│  Digested: 143/143 · Duplicates: never run       │
└──────────────────────────────────────────────────┘

? What would you like to do?
❯ 🔍  Find Duplicates            143 unanalyzed
  📊  View Report
  🔄  Sync with GitHub
  ──────────────────
  ✕   Exit

[user selects Find Duplicates]

🔍 Checking 143 issues for duplicates...
  ████████████████████ done — 11 duplicates found in 8 groups

GROUP 1 of 8 ────────────────────────────────────
  ORIGINAL   #12   Login page crashes on Safari iOS
  DUPLICATE  #89   App broken on iPhone — can't log in

  Confidence: 94%
  Reason: Both describe Safari iOS login failure; #89 adds no new info.

? What do you want to do with #89?
❯ Mark as duplicate in store only
  Mark as duplicate + add label on GitHub
  Skip — not a duplicate
  Open both in browser to compare
  Stop reviewing
```

### Use Case B — New Issue Just Filed

```bash
$ issue-manager sync
✓ Fetched 1 new issue (#201), 0 updated
  Re-digested: 1 issue
  1 issue needs duplicate check — run 'issue-manager run duplicates'

$ issue-manager run duplicates
  Checking 1 new issue against 143 in store...
  1 duplicate found.

  #201 → duplicate of #89 (confidence: 91%)
  Reason: Both report checkout total not updating after discount code.

  Mark #201 as duplicate on GitHub? (Y/n) Y
  ✓ Label applied to #201
```

### Use Case C — Weekly Triage

```bash
$ issue-manager sync
✓ 3 new · 2 updated · 1 closed
  Re-digested: 4 issues (content changed)
  ⚠ 2 issues with stale analysis — run 'issue-manager run duplicates --recheck'

$ issue-manager
  [hub shows "Find Duplicates   4 unanalyzed"]
  [user selects, reviews 4 issues, done in ~2 min]
```

### Use Case D — CI Pipeline

```bash
# .github/workflows/triage.yml
- run: issue-manager sync
- run: issue-manager run duplicates --apply --no-interactive --format json > duplicates.json
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `run <action>` with no store | Exit 1: "Store not found. Run `issue-manager init` first." |
| Action with no digested issues | Exit 1: "No digested issues. Run `issue-manager sync`." |
| Unknown action id in `run` | Exit 1: "Unknown action 'xyz'. Available: duplicates" |
| GitHub 401 | Exit 1: "Invalid GitHub token. Check GITHUB_TOKEN env var." |
| GitHub 403 rate limit | Print reset time, exit 1 |
| GitHub 404 | Exit 1: "Repo '{owner}/{repo}' not found or inaccessible." |
| Anthropic API error | Warn, save partial progress, exit 2 |
| LLM JSON parse error | Retry once with correction prompt. If fails, skip batch + warn. |
| Store write failure | Keep tmp file at path, print path for manual recovery |
| `--apply` in non-TTY without `--no-interactive` | Prompt to confirm, or require explicit flag |

Exit codes: `0` success · `1` fatal error · `2` partial success

---

## Implementation Order for Claude Code

Strictly follow this order — each step is compilable and testable before moving on.

**Step 1 — Foundation**
1. `src/store/store.model.ts` — all zod schemas, all TypeScript types
2. `src/models/config.model.ts` — config schema
3. `src/utils/hash.ts` — 3 lines, no deps
4. `src/utils/config.ts` — cosmiconfig loader
5. `src/store/store.ts` — atomic read/write, queries, mutations
6. Write `tests/store/store.test.ts` — test upsert, setAnalysis, contentHash detection
7. `src/utils/chunker.ts` + tests

**Step 2 — Services**
8. `src/services/github.service.ts` + tests (mock Octokit)
9. `src/services/llm.service.ts` + tests (mock Anthropic SDK)

**Step 3 — Data Commands**
10. `src/commands/init.ts` — orchestrates github + llm + store
11. `src/commands/sync.ts` — incremental update with cursor + hash diff
12. `src/commands/status.ts` — read-only store render

**Step 4 — Action Infrastructure**
13. `src/actions/action.interface.ts` — the interface
14. `src/actions/registry.ts` — the registry singleton

**Step 5 — First Action (Duplicates)**
15. `src/actions/duplicates/prompt.ts` — prompt template
16. `src/actions/duplicates/runner.ts` — detection logic + tests
17. `src/ui/components/progress.ts` — ora wrapper
18. `src/ui/components/table.ts` — cli-table3 wrapper
19. `src/ui/components/confirm.ts` — inquirer confirm wrapper
20. `src/actions/duplicates/interactive.ts` — group review UX
21. `src/actions/duplicates/index.ts` — registers the action

**Step 6 — Entry Point and Hub**
22. `src/ui/status.ts` — boxen status header
23. `src/ui/hub.ts` — interactive menu
24. `src/commands/run.ts` — non-interactive action runner
25. `src/index.ts` — Commander setup, shebang, import side effects

**Step 7 — Polish**
26. `src/utils/formatter.ts` — shared table/markdown/json renderers
27. Verify all exit codes are correct
28. `npm run build && npm link && issue-manager init -o <test-repo>`

---

## Extensibility Checklist — Adding a Future Action

To add the `priority` action after launch, the only steps are:

1. Create `src/actions/priority/` with `prompt.ts`, `runner.ts`, `interactive.ts`, `index.ts`
2. Add `import './actions/priority/index.ts'` to `src/index.ts`
3. The hub auto-discovers it. The `run` command auto-supports `issue-manager run priority`.
4. The action writes to `analysis.priority` — a field already reserved in the store schema.

No changes to `registry.ts`, `hub.ts`, `store.model.ts`, or any other existing file.

---

## Known Limitations

- **Candidates vs candidates:** The duplicate prompt compares candidates against the knowledge base but not candidates against each other. If two brand-new issues are duplicates of each other (no prior issue exists), one will be missed. Mitigation: after a sync + duplicate run, run `--recheck` once to catch these. Future: two-pass detection.
- **Store concurrency:** File-based lock prevents two simultaneous writes but not two simultaneous reads followed by writes. Never run two commands at once on the same store.
- **Confidence calibration:** Claude's confidence scores are relative, not absolute. A score of 0.85 means "probably the same" not "85% statistical probability". The threshold (default 0.80) may need tuning per repo. Expose as config: `sync.minDuplicateConfidence`.
