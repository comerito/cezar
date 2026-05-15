# Phase 0 notes — de-risking the agent abstraction

**Date:** 2026-05-11
**Scope:** `packages/core/src/agents/**` + the `agent-session.ts` compatibility shim. No `packages/cli` / `packages/gui` changes. Nothing committed.

This implements the Phase 0 deliverables from `docs/REFACTOR-PLAN-agent-cockpit.md` (§3.1 / §3.5 / §4): the `AgentRunner` interface, normalized `AgentEvent` model, `AnthropicApiRunner` (verbatim extraction of the old loop), spike `ClaudeCodeCliRunner` / `CodexCliRunner`, and a `RunnerFactory`.

---

## CLI flags used (and how far they were verified)

`claude --help` and `codex exec --help` **were** available on this box, so the flag *names* are real. The *end-to-end behavior* (real auth, real model output, real `stream-json` / `--json` event payloads) was **not** exercised — the spikes are wired and unit-tested against canned transcripts, not a live run. That live run is the explicit Phase 4 hardening step.

### `ClaudeCodeCliRunner` — `claude` v2.x (`claude --help` confirmed all flags below exist)

```
claude -p "<userPrompt>" \
  --output-format stream-json --verbose \
  --append-system-prompt "<systemPrompt>" \
  --permission-mode acceptEdits \
  [--allowedTools "Read,Grep,Bash"] \
  [--model <model>] \
  [--add-dir <dir> ...]
```

- `-p` / `--print` — headless mode. Required for `--output-format`, `--max-budget-usd`, etc.
- `--output-format stream-json --verbose` — NDJSON event stream. (`--verbose` is required for `stream-json` per the help text.) Parsed event shapes assumed: `{type:'system',subtype:'init',...}`, `{type:'assistant',message:{content:[...],usage}}`, `{type:'user',message:{content:[{type:'tool_result',...}]}}`, `{type:'result',subtype,is_error,result,usage,total_cost_usd}`. **The exact `result`/`usage` schema is unverified against a live run** — TODO(phase-0) comments mark this in the runner.
- `--append-system-prompt` — keeps the default Claude Code system prompt and *appends* our step prompt, which matches the plan's "skills augment, never replace" intent (the step prompt itself is the "skill body" appended upstream).
- `--permission-mode acceptEdits` — there is no TTY in headless mode, so edits must be auto-accepted. (`--permission-mode` is a real flag; values include `acceptEdits`.)
- `--allowedTools` — the sandbox. Note: the headless CLI does **not** expose the SDK's per-call `canUseTool` hook, so the *bash command allowlist* (`AgentRunSpec.bashAllowlist`) is currently only recorded/auditable, not enforced pre-call, for this backend. Phase 4 should map it onto `Bash(prefix *)` allowlist patterns (the CLI's help shows `--allowedTools` accepts `"Bash(git *) Edit"`-style entries).
- **No `--max-turns` equivalent** — only `--max-budget-usd`. `AgentRunSpec.maxTurns` is ignored for this backend; we rely on `tokenBudget` instead. (TODO marked.)
- `--json-schema <schema>` exists and could enforce structured output server-side; for now we extract the final assistant text via `parseStructured` so behavior matches the API path. Wiring `--json-schema` is a Phase 1+ follow-up.

Binary missing → `Error('claude CLI not found on PATH — install Claude Code or use the anthropic-api backend')`.

### `CodexCliRunner` — `codex-cli` v0.128 (`codex exec --help` confirmed all flags below exist)

```
codex exec --json --skip-git-repo-check -s workspace-write \
  --cd <cwd> \
  [--add-dir <dir> ...] \
  [-m <model>] \
  "<systemPrompt>\n\n---\n\n<userPrompt>"
```

- `exec` — non-interactive mode.
- `--json` — JSONL event stream. **Codex's event envelope is the least documented of the three** — we handle both `{type, ...}` flat and `{id, msg:{type, ...}}` shapes and ignore unknown event types. Event-type names assumed (`agent_message` / `agent_message_delta` / `exec_command_begin` / `exec_command_end` / `patch_apply_begin` / `token_count` / `error` / `task_complete`) are **unverified against a live transcript** — TODO(phase-0) marked.
- `-s workspace-write` — the sandbox. Codex has **no per-tool allowlist hook at all**; this coarse mode + a worktree-only `--cd` is the entire CLI-side sandbox. `allowedTools` from the spec is effectively unused by this backend (kept in the API for symmetry / future container policy).
- `--cd <cwd>` — explicit working root (we also pass `cwd` to `spawn`).
- `--skip-git-repo-check` — autofix worktrees may not be a repo root; without this Codex hard-fails.
- No `--append-system-prompt` equivalent → the system prompt is folded into the prompt body with a `---` separator. TODO marked.
- `--output-schema <FILE>` exists (would enforce the response shape) but requires writing a temp file; skipped for parity with the other backends. `--output-last-message <FILE>` is another option for grabbing the final answer reliably — worth considering in Phase 4.
- `token_count` events carry `total_token_usage.total_tokens`; that's what we accumulate (no cache breakdown, so the cost-weighting in `structured-output.ts` is a no-op for this backend).

Binary missing → `Error('codex CLI not found on PATH — install the Codex CLI or use the anthropic-api backend')`.

---

## Usage telemetry surfaced per backend

| Backend | Per-turn usage | Cache breakdown | Cost (USD) | Notes |
|---|---|---|---|---|
| `anthropic-api` (SDK) | yes — `usage` on assistant + `result` messages | yes (`cache_creation_input_tokens`, `cache_read_input_tokens`) — cost-weighted in `structured-output.ts` | not directly (would need pricing table); `result.total_cost_usd` sometimes present | Unchanged from today. Token budget enforced per-turn, interrupts the stream on breach. |
| `claude-cli` | yes — `usage` on each `assistant` message and the final `result` message | yes (same fields as the SDK) | `result.total_cost_usd` is emitted by headless `stream-json` — best single source for `agent_runs.cost_estimate` | Budget enforced per-turn; on breach we `SIGTERM` the subprocess. **Unverified live.** |
| `codex-cli` | yes — `token_count` events with `total_token_usage.total_tokens` (cumulative-ish) | **no** breakdown | **no** cost in the event stream — `agent_runs.cost_estimate` will be `null` ("unknown") for this backend, exactly as the plan anticipates | Coarsest telemetry. Budget enforced when a `token_count` arrives; `SIGTERM` on breach. **Unverified live.** |

All three normalize into the same `AgentEvent` stream (`text` · `tool-call` · `tool-result` · `token-usage` · `note` · `done` · `error`) and the same `AgentRunResult` (`text`, `parsed`, `toolCalls`, `tokensUsed`, `budgetExceeded`).

---

## Phase 0 gate verdict

**API path: solid.** `AnthropicApiRunner` is a verbatim extraction of the old `runAgentSession` loop — same `canUseTool` tool + bash allowlist enforcement, same cache-weighted budget accounting, same `ERR_STREAM_WRITE_AFTER_END` guard, same interrupt-on-budget. The autofix orchestrator and the existing `tests/actions/autofix/*` are unchanged and green; the new shim maps the normalized events back to the legacy `AgentEvent` shape the CLI/GUI consume. Zero behavior change.

**Claude CLI path: solid by construction, needs one live run.** Every flag is real (`claude --help` confirmed). The `stream-json` parser handles `system`/`assistant`/`user`/`result` and is unit-tested against a canned transcript. The two open items are (a) the precise `result`/`usage` payload schema and (b) wiring `bashAllowlist` onto `Bash(prefix *)` patterns since there's no `canUseTool` hook headlessly. Both are Phase 4 work, not blockers. **Recommended: proceed.**

**Codex CLI path: highest risk — escape-hatch territory.** The flags are real (`codex exec --help` confirmed) but the `--json` event-envelope schema and event-type names are derived from docs/inference, not a live transcript; there's no per-tool allowlist; no cost telemetry; no system-prompt flag. The runner is written defensively (handles two envelope shapes, ignores unknown events) and unit-tested, but **a live `codex exec --json` run against a real issue is required before this backend can be trusted.** Per the plan's escape hatch (§Phase 0): if that live verification fails, the cockpit can launch with `anthropic-api` + `claude-cli` and mark Codex "coming soon" — the abstraction supports dropping it without code churn (just don't register it in `createAgentRunner`'s allowed set / the runner's advertised backends).

**Bottom line:** *API + Claude CLI are the non-negotiable minimum and both are in good shape; Codex is wired but needs live verification before Phase 4 commits to it.* This matches the plan's expected outcome.

---

## Follow-ups for Phase 4 hardening

- **Live-run all three** against one real analyzer step on a real repo; capture actual `stream-json` / `--json` transcripts and tighten the parsers + `// TODO(phase-0):` comments to match.
- **Claude CLI bash allowlist:** translate `AgentRunSpec.bashAllowlist` into `--allowedTools "Bash(git log:*) Bash(git diff:*) ..."` patterns; today it's recorded but not enforced pre-call for that backend.
- **Codex sandbox:** decide whether `-s workspace-write` + `--cd` is sufficient or whether cloud runners need an OS container around it; Codex has no finer hook.
- **Cost normalization:** pull `total_cost_usd` from the Claude CLI `result` message into `agent_runs.cost_estimate`; build a pricing table for the API path; leave Codex as `null`/"unknown".
- **Structured output:** consider `claude --json-schema` and `codex exec --output-schema` to enforce the response shape server-side instead of (or in addition to) `parseStructured` on the final text.
- **Cancellation:** `interrupt()` here is a cooperative `SIGTERM` (CLIs) / SDK iterator interrupt (API). The runner layer (Phase 4 `packages/runner`) owns the hard `SIGKILL`-after-timeout fallback and worktree disposal.
- **`maxTurns` for the Claude CLI:** revisit if the headless CLI ever grows a turn cap; until then it's budget-only for that backend.
- **`event.port.ts` convergence:** the legacy `AgentEvent` (consumed by CLI verbose + GUI event bridge) and the new normalized `AgentEvent` (`agents/agent-runner.ts`, re-exported from `@cezar/core` as `RunnerAgentEvent`) coexist via the shim's translator. When the workflow engine lands (Phase 2) the GUI/CLI event sinks should migrate onto the normalized type and the legacy one can be dropped.
