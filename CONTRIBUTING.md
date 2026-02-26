# Contributing to Cezar

Thanks for your interest in contributing to Cezar! Whether it's fixing a bug, adding a new analysis action, or improving docs — all contributions are welcome.

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
git clone https://github.com/comerito/cezar.git
cd cezar
npm install
```

### Development Workflow

```bash
npm run dev          # Watch mode with tsx
npm run typecheck    # Type-check without emitting
npm run test         # Run all tests once
npm run test:watch   # Run tests in watch mode
npm run build        # Compile TypeScript to dist/
```

Run a single test file:

```bash
npx vitest run tests/store/store.test.ts
```

## Code Standards

- **TypeScript strict mode** — no `any`, no implicit returns, no unused variables
- **ESM only** — use `.js` extensions in imports (TypeScript compiles to ESM)
- **Zod for validation** — all external data (config, LLM responses, store files) must be validated through Zod schemas
- **Tests required** — new logic needs tests. We use Vitest with mocked external services (no real API calls in tests)

## Project Architecture

Understanding the data flow helps orient contributions:

```
GitHub API  ──>  Local Store  ──>  AI Digests  ──>  Actions (e.g. duplicates)
   (fetch)       (store.json)       (Claude)         (analyze + triage)
```

Key design decisions:

- **Store as source of truth** — a single JSON file with atomic writes. No database.
- **Actions are plugins** — self-contained folders in `src/actions/` that register themselves.
- **Interactive-by-default, scriptable-by-flag** — every command works without a TTY when given `--no-interactive`.

## Adding a New Action

This is the most impactful way to contribute. The plugin architecture makes it straightforward.

### 1. Create the action folder

```
src/actions/your-action/
├── prompt.ts         # LLM prompt template
├── runner.ts         # Core logic
├── interactive.ts    # Interactive review UI
└── index.ts          # Registers the action
```

### 2. Implement the runner

Your runner receives the store and config, does its analysis, and returns results:

```typescript
// src/actions/your-action/runner.ts
export class YourActionRunner {
  constructor(private store: IssueStore, private config: Config) {}

  async run(options: YourOptions): Promise<YourResults> {
    const issues = this.store.getIssues({ state: 'open', hasDigest: true });
    // ... your logic here
  }
}
```

### 3. Register the action

```typescript
// src/actions/your-action/index.ts
import { actionRegistry } from '../registry.js';

actionRegistry.register({
  id: 'your-action',
  label: 'Your Action',
  description: 'What it does in one line',
  icon: '🎯',

  getBadge(store) {
    // Return a short string like "12 unanalyzed" or "up to date"
    return '';
  },

  isAvailable(store) {
    // Return true or a reason string like "no digested issues"
    return true;
  },

  async run({ store, config, interactive, options }) {
    // Wire up your runner and interactive UI
  },
});
```

### 4. Add the side-effect import

In `src/index.ts`, add:

```typescript
import './actions/your-action/index.js';
```

That's it. The hub and `run` command will automatically discover your action.

### 5. Write tests

Create `tests/actions/your-action/runner.test.ts`. Mock external services — never call real APIs in tests.

### 6. Reserve store fields (if needed)

If your action writes analysis results to the store, add the fields to `IssueAnalysisSchema` in `src/store/store.model.ts` with `.nullable().default(null)`. Each action writes to its own namespace — actions are independent.

## Submitting Changes

### Branch naming

- `feat/description` for new features
- `fix/description` for bug fixes
- `docs/description` for documentation

### Commit messages

Use clear, concise commit messages:

```
feat: add priority scoring action
fix: handle empty issue body in digest generation
docs: add CI pipeline example to README
```

### Pull request process

1. Fork the repo and create your branch from `main`
2. Make your changes and ensure all checks pass:
   ```bash
   npm run typecheck   # zero errors
   npm run test        # all passing
   npm run build       # clean build
   ```
3. Open a PR with a clear description of what changed and why
4. Reference any related issues

### What we look for in reviews

- Does it compile under strict mode with zero errors?
- Are there tests for new logic?
- Does it follow existing patterns? (e.g., Zod for validation, ora for spinners, chalk for colors)
- Does it work in both interactive and `--no-interactive` modes?
- Are external services mocked in tests?

## Reporting Issues

Found a bug or have a feature idea? [Open an issue](https://github.com/comerito/cezar/issues) with:

- **Bugs**: steps to reproduce, expected vs actual behavior, Node.js version
- **Features**: the use case it solves and a rough idea of the approach

## Questions?

Open a [discussion](https://github.com/comerito/cezar/discussions) or reach out via issues. We're happy to help newcomers get oriented in the codebase.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
