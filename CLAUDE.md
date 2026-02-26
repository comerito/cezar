# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cezar is an AI-powered GitHub issue manager CLI. It syncs issues locally, generates Claude-powered digests, then lets users triage through an interactive terminal UI. The first action is duplicate detection — more actions are planned. Designed for both interactive use and CI pipelines.

**Status:** Specification-complete, implementation follows the strict 28-step order in `github-issue-manager-SPEC-v3.md`.

## Commands

```bash
npm run build           # tsc && chmod +x dist/index.js
npm run dev             # tsx watch src/index.ts
npm run test            # vitest run
npm run test:watch      # vitest (watch mode)
npm run typecheck       # tsc --noEmit
npm run lint            # eslint src/
```

Run a single test file:
```bash
npx vitest run tests/store/store.test.ts
```

## Tech Stack

- **TypeScript 5.x** (strict mode, ES2022 target, NodeNext modules, ESM)
- **Node.js 20+** — native fetch, ESM support
- **Commander.js** — CLI routing
- **@inquirer/prompts** — interactive menus (not ink/React)
- **@octokit/rest** — GitHub API
- **@anthropic-ai/sdk** — Claude API (streaming)
- **Zod** — validation for config and LLM responses
- **vitest** — test runner
- **cosmiconfig** — config discovery (`.issuemanagerrc.json`)
- **Local JSON store** at `.issue-store/store.json` — no database

## Architecture

### Data Flow (Three Phases)

1. **Fetch** — `init`/`sync` pulls issues from GitHub API into the local store
2. **Digest** — Claude generates compact summaries for each issue
3. **Analyze** — Actions (e.g., duplicate detection) run against digested issues

### Key Design Patterns

**Action Plugin System** (`src/actions/`): Every analysis capability is a self-contained action conforming to `ActionDefinition` interface. Actions register themselves via side-effect imports in `src/index.ts`. The hub auto-discovers registered actions. To add a new action: create `src/actions/{name}/` with `prompt.ts`, `runner.ts`, `interactive.ts`, `index.ts`, then add the import to `src/index.ts`.

**Store as Source of Truth** (`src/store/`): Single JSON file with atomic writes. Each action writes to its own namespace in the `analysis` object — actions are independent and can run in any order. Zod schemas validate all store data.

**Interactive-by-Default, Scriptable-by-Flag**: The hub (`src/ui/hub.ts`) is the primary UX. Non-interactive mode via `--no-interactive` flag enables CI usage. `--apply` applies results without confirmation, `--dry-run` previews changes.

### Entry Points

- `src/index.ts` — Commander setup, shebang, action side-effect imports
- `src/ui/hub.ts` — Interactive menu (launched when no args given)
- `src/commands/` — `init.ts`, `sync.ts`, `run.ts`, `status.ts`

### Services

- `src/services/github.service.ts` — Octokit wrapper (fetch, label, update issues)
- `src/services/llm.service.ts` — Anthropic SDK wrapper (digest generation, duplicate detection), batched with JSON response validation

## Implementation Order

Follow the strict order in the spec (`github-issue-manager-SPEC-v3.md`, "Implementation Order for Claude Code" section). Each step must be compilable and testable before moving on:

1. **Foundation** (steps 1-7): Store schemas, config, utils, store module + tests, chunker + tests
2. **Services** (steps 8-9): GitHub service + tests, LLM service + tests
3. **Data Commands** (steps 10-12): init, sync, status commands
4. **Action Infrastructure** (steps 13-14): ActionDefinition interface, registry singleton
5. **First Action** (steps 15-21): Duplicates (prompt, runner, UI components, interactive review, registration)
6. **Entry Point and Hub** (steps 22-25): Status renderer, hub menu, run command, index.ts
7. **Polish** (steps 26-28): Shared formatters, exit codes, build + link + smoke test

## Environment Variables

- `GITHUB_TOKEN` — GitHub API authentication
- `ANTHROPIC_API_KEY` — Claude API authentication
