/**
 * Shared "how to operate" instructions appended to every autofix-stage
 * agent system prompt (verify-in-repo, analyzer, fixer, reviewer).
 *
 * Two goals:
 *
 *   1. **Path conventions** — the agent runs with cwd set to the worktree
 *      (e.g. `/tmp/cezar-autofix-xxx/repo`). Without explicit instruction,
 *      Claude defaults to absolute paths like `/repo/scripts/dev.mjs`,
 *      which all fail and burn 2–3 turns recovering via Glob. One line
 *      here saves ~60k tokens per run.
 *
 *   2. **Parallel tool calls** — the SDK supports multiple `tool_use`
 *      blocks per assistant turn, but unprompted Claude tends to emit one
 *      tool call per turn. Instructing it to batch reads cuts exploration
 *      turn count by roughly half on multi-file analyses.
 *
 * Kept as a single shared constant on purpose: the SDK auto-caches the
 * system prompt prefix via Anthropic prompt caching, and identical
 * guidance across all four agents means more of each step's system
 * prompt overlaps and stays in cache.
 */
export const AGENT_EXECUTION_GUIDANCE = `

## Execution conventions

**Paths.** Your tools run with the repository checked out as your current
working directory. Always use paths relative to that directory (e.g.
\`scripts/dev.mjs\`, \`packages/core/src/index.ts\`). Never prefix paths with
\`/repo\`, \`/workspace\`, or any other absolute root that you assume — those
prefixes are guesses and will fail with "File does not exist", costing
you a turn each. If you genuinely need the absolute path, call
\`Bash(pwd)\` once and reuse the result.

**Parallelism.** When you need to read or grep multiple files, emit ALL
of those tool calls in the same turn as parallel \`tool_use\` blocks
rather than one per turn. The runtime executes them concurrently; a
single turn with 5 parallel Reads is the same wall-clock cost as a
single Read. Sequential one-Read-per-turn loops waste turns and tokens.

**Stop early.** As soon as you have enough evidence to write your final
JSON answer, stop. Additional exploration past that point doesn't change
the verdict and consumes the turn / token budget the later steps need.
`;
