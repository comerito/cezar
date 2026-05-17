# Persistent-Session Autofix — Refactor Plan

**Status:** proposal. No code yet. Win-now borrowings (session-id pinning,
90s autosave, dry-run mock) land separately and are independent of this
plan.

**Companion docs:** `docs/REFACTOR-PLAN-agent-cockpit.md` (the data-driven
cockpit), `docs/claude-subscription-runner.md` (the Janitor reference that
inspired this).

---

## 1. What's being proposed

Replace today's four-process autofix pipeline (verify → analyze → fix →
review, each its own `claude -p` invocation) with **one** long-lived
`claude` process holding a single conversation through all four roles.
The user-message stream-json stdin protocol replaces the per-step
`--print` arg.

```
                           TODAY
                           ─────
   spawn ─► claude -p (verify)   ─ exit ─►  parse  ┐
   spawn ─► claude -p (analyze)  ─ exit ─►  parse  ├─►  workflow_runs
   spawn ─► claude -p (fix)      ─ exit ─►  parse  │     row finalize
   spawn ─► claude -p (review)   ─ exit ─►  parse  ┘

                           TARGET
                           ──────
   spawn ─► claude --input-format stream-json (no -p)
              │
              ├─► stdin: {role:user, content:"verify this..."}
              │   stdout: {assistant: ...JSON...}
              ├─► stdin: {role:user, content:"analyze..."}
              │   stdout: {assistant: ...JSON...}
              ├─► stdin: {role:user, content:"implement fix..."}
              │   stdout: {assistant: ...edits files + JSON...}
              ├─► stdin: {role:user, content:"review what you did..."}
              │   stdout: {assistant: ...JSON...}
              └─► exit ─►  one workflow_runs row, one cache prefix
```

## 2. Why

Three concrete wins, in descending order of impact:

1. **Prompt-cache reuse across the whole run.** Anthropic's prompt cache
   discounts read-back tokens to ~10% of normal input. Today each step
   starts a fresh session — the cache resets every time. A single
   conversation keeps everything cached from T1 onward, so by the time
   the reviewer runs at T4 it's reading ~90% of its context at the 10%
   rate. On the #1950 run that timed out, this is the difference
   between ~470k cost-weighted tokens and an estimated ~150k.

2. **Tool-result reuse.** The fixer needs everything the analyzer read.
   Today the fixer re-reads those files from scratch. In a single
   session the analyzer's Reads sit in the conversation history — the
   fixer can refer to them without re-fetching. Saves both wall-clock
   and tokens.

3. **No per-step spawn cost.** ~500-1000ms cold start × 4 steps = 2-4s.
   Small relative to (1) and (2), but free once we've done the work.

A fourth win, mostly architectural: the cockpit's "live event stream"
becomes a real stream instead of being stitched from four
finished-then-rendered chunks. Operators see the agent's thinking in
real time across the whole run.

## 3. The constraint that shapes everything

**A single `claude` session has one system prompt for its lifetime.**
You cannot swap system prompts mid-conversation. This is enforced by
both `--append-system-prompt` (set at spawn) and by Anthropic's chat
API semantics (system message is per-request, not per-message).

Consequences:

- Today's four specialised system prompts (ANALYZER_SYSTEM_PROMPT,
  FIXER_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT, VERIFY_IN_REPO_SYSTEM_PROMPT)
  collapse into **one unified autofix system prompt** that describes
  all four roles and how to switch between them.
- The user-facing "step" abstraction in the cockpit becomes a
  presentation concern, not an execution concern. We can keep showing
  `analyzer / fixer / reviewer` rows by detecting role transitions in
  the stream, but they're no longer separate process runs.
- Per-step model choices (Sonnet 4.6 for analyzer/fixer, Haiku 4.5 for
  reviewer) collapse into one model. The cheap-reviewer optimization
  goes away. Recommendation: Sonnet 4.6 for the whole run — the cache
  reuse more than offsets the loss of Haiku.

## 4. The unified system prompt — shape

```text
You are the Cezar AUTOFIX agent. Across this conversation you will play
four roles in sequence:

  1. VERIFY-IN-REPO — confirm the reported issue is a real, still-unfixed
     defect (vs already fixed / expected behavior / not a bug).
  2. ANALYZER — locate the root cause; do not edit files.
  3. FIXER — implement the smallest correct fix.
  4. REVIEWER — review what you fixed and verdict pass/fail.

The user will explicitly mark the start of each phase. When the user
sends a phase marker (e.g. "## PHASE: ANALYZER"), switch role and
end your turn with the structured JSON the phase requires (schemas
below). Do NOT proceed to the next phase on your own — wait for the
user's next phase marker.

## Phase schemas
... <each Zod schema rendered as JSON Schema, same as today> ...

## Execution conventions
... <AGENT_EXECUTION_GUIDANCE — paths, parallelism, stop-early> ...
```

The reusable parts (schemas, execution conventions, skill docs) get
written **once**, cached **once**. The volatile parts (issue body,
file contents the agent has read, prior-attempt notes) are user
messages that come later in the conversation and contribute only their
own tokens.

## 5. Phases of work

Each phase is independently shippable, each leaves the system green,
each can be rolled back by reverting one commit.

### Phase 0 — Win-now borrowings ⭐ (this PR's siblings)

These don't require persistent sessions; they're net-good independent
of the bigger refactor.

- [x] `--session-id <agent_run.id>` pinning so operators can
      `claude --resume <uuid>` a failed step. **Lands now.**
- [x] 90-second autosave commits during write-capable steps
      (fixer). **Lands now.**
- [x] Dry-run mock binary swapped in when `CEZAR_DRY_RUN=1`. **Lands now.**

### Phase A — Persistent process, per-step prompts (no behavior change)

Wrap the existing per-step spawn in a kept-alive `claude` child that
reads stream-json on stdin. **Still uses one system prompt per step,
just one `claude` process for the whole run** by closing-and-reopening
between steps — i.e. we spawn one claude per step still, but the
runner uses stream-json stdin instead of `-p`.

- New `ClaudeCodeCliRunner` mode: `transport: 'stream-json'` (the
  current path stays as `transport: 'print'` for fallback).
- `runStep(userPrompt)` writes `{"type":"user","message":...}` to
  stdin, reads stream-json messages from stdout until a
  `{"type":"result"}` line, returns the last `assistant` text.
- The session is closed at end of step (we still need to change the
  system prompt for the next step).
- Configuration flag: `config.autofix.runner.transport` defaults to
  `'print'` (today's behavior). Opt-in via `'stream-json'`.

**Win:** none yet — same number of processes, same cache resets. But
the plumbing is now in place for Phase B.

**Test:** the autofix orchestrator tests should pass byte-for-byte
under both transports (the agent-runner tests already mock the
subprocess; add a stream-json transport variant).

### Phase B — Unified system prompt, single session

The actual collapse.

- Write the unified autofix system prompt (`prompts/autofix-unified.ts`).
  Concatenates the four old prompts plus phase markers plus skills.
- Workflow definition gains a `mode: 'unified' | 'staged'` toggle.
  `'staged'` is today's path. `'unified'` switches to:
  1. Spawn one `claude --input-format stream-json --append-system-prompt <unified>`.
  2. Send phase marker for VERIFY, await JSON, validate.
  3. Send phase marker for ANALYZE, await JSON, validate.
  4. Send phase marker for FIX, await assistant turn ending with JSON.
  5. Send phase marker for REVIEW, await JSON.
  6. Close child.
- The cockpit's `agent_runs` table still gets four rows — they
  represent role transitions inside the conversation. The
  `agent_run.session_id` for all four points to the same claude
  session (which the operator can resume).
- Per-phase max-turns become a per-phase **user-message hint**
  ("you have at most 10 tool calls before returning the JSON"). Hard
  enforcement happens via `--max-budget-usd` for the whole session.

**Win:** 60-70% reduction in cost-weighted tokens; same wall-clock
floor as Phase A but the floor is much lower because of cache reuse.

**Toggle:** `config.autofix.runner.mode = 'unified' | 'staged'`,
defaults `'staged'`. Per-workspace override possible via Settings →
Autofix. Roll out by flipping one workspace at a time.

**Cockpit changes:** event stream needs a new event type
`{type: 'phase-transition', phase: 'analyzer'}` so the UI can keep
showing per-phase headers even though it's one underlying session.

### Phase C — Human-gate inside the conversation

The autofix workflow has a `confirm-fix-plan` gate today between
analyzer and fixer. In the staged path it's a `workflow_runs.status =
'paused'` between two process spawns.

In unified mode, the gate just means **delay sending the next user
message**. The claude process sits idle waiting for stdin. When the
human accepts/rejects in the cockpit, we either send the FIX phase
marker or kill the session.

- `human-gate` workflow step gets a unified-mode implementation: the
  workflow row is marked `paused`, the runner keeps the claude child
  alive, the runner waits on a Supabase channel for the resume
  signal.
- Heartbeat: the persistent child writes nothing while idle; we send
  a no-op assistant ping every ~5 min if needed to keep the SDK happy
  (or accept that a multi-hour idle wait will time out and we resume
  by spawning a fresh session — which is fine, it's just a Phase A
  fallback).

### Phase D — Stream into the cockpit

Today the cockpit polls `agent_run_events`. In unified mode, the
runner streams every `assistant` token / `tool_use` block to
`agent_run_events` via Supabase Realtime broadcasts. Operators see
the agent's thinking live across the whole run.

This is independent of A/B/C but builds on them — only worth
implementing once the long single-session is the primary path.

## 6. Trade-offs

| Today's behavior | Unified-session behavior | Worth it? |
|---|---|---|
| 4 specialised system prompts, ~3k chars each | 1 unified prompt, ~9k chars | Yes — cache amortises it |
| Per-step max-turns (15/30/10) | One pooled budget via `--max-budget-usd` | Coarser, but cheaper overall |
| Per-step model (Sonnet/Sonnet/Haiku) | One model for whole session | Lose Haiku savings; gain cache savings |
| Structured JSON enforced per step (clean parse boundaries) | Each phase marker still demands JSON, but parser must scan within a long transcript | Marginally messier; doable |
| Cockpit shows discrete steps with their own `agent_runs` row | Cockpit shows phases derived from in-stream markers | Mostly cosmetic, requires UI tweak |
| Can swap claude → API by changing backend | Tightly couples autofix to claude CLI's stream-json contract | Real downside — see §7 |

## 7. Open questions

1. **Does `--input-format stream-json --output-format stream-json`
   give us stable phase markers in the output stream?** Need a one-day
   spike: run a unified prompt with phase markers as user messages,
   verify the model reliably responds with the JSON shape per phase.
2. **Cache hit rate at scale.** Anthropic's cache TTL is 5 min by
   default (configurable). A long autofix run with a 20-min fixer step
   will partially exhaust the cache. Need to measure on a real run
   what fraction of tokens actually read from cache.
3. **Resumability after process crash.** If the runner process dies
   mid-conversation, can we resume the claude session from disk
   history (`~/.claude/sessions/<uuid>.json`) via `--resume`? Janitor
   relies on this for operator handoff; we'd rely on it for crash
   recovery.
4. **API backend equivalent.** `AnthropicApiRunner` (the SDK path)
   uses `@anthropic-ai/claude-agent-sdk` which has its own session
   semantics. Does the same unified-prompt pattern work there, or do
   we lock unified mode to the CLI backend? If the latter, the runner
   factory needs to refuse the API backend when `mode='unified'`.
5. **Cost-weighted token telemetry.** Today we sum
   `tokensUsed` per step. With one session, we get one combined total —
   need to split it back per phase for the cockpit so the per-step
   "Tokens" column still works. Easiest: track tokens at phase
   transitions and store deltas as `agent_runs.tokens_used`.
6. **What happens if the model emits JSON for the wrong phase?** Today
   each step's schema enforces this; mismatch → fail. Unified mode
   needs the same enforcement — easiest is to validate the schema for
   the *currently expected* phase against the assistant's final JSON
   and ask for a re-emit if it doesn't match.

## 8. Migration / rollout

1. **Phase 0** lands now — three independent commits, zero risk.
2. **Phase A** lands behind `config.autofix.runner.transport: 'stream-json'`
   opt-in. Validate on a few real workspaces before flipping default.
3. **Phase B** lands behind `config.autofix.runner.mode: 'unified'`
   opt-in. Both modes coexist; same tests run both via parameterized
   describe blocks.
4. **Phase C** extends Phase B — only meaningful once unified is
   default. The legacy human-gate code path stays as the staged-mode
   implementation.
5. **Phase D** is purely additive; lands whenever it's ready.
6. **Cutover:** flip the default to `'unified'` after a workspace has
   run 50+ successful autofix runs in unified mode. Keep the
   `'staged'` mode behind a config flag for two releases, then
   delete.

## 9. Rollback

Each phase reverts cleanly:
- Phase A revert: delete the stream-json transport, fall back to
  `-p`. Tests still pass.
- Phase B revert: flip default mode back to `'staged'`. Workflow
  definition unchanged.
- Phase C/D revert: feature flag off.

The decisive irreversible step is **rewriting the system prompts as
phase-marker-aware**. Even that can be reverted by checking out the
prior file — the per-step prompts are preserved verbatim as the
"staged-mode" fallback.

## 10. Not-doing

These are out of scope for this plan, called out so we don't
accidentally do them:

- **Replace `@anthropic-ai/claude-agent-sdk` with direct
  `@anthropic-ai/sdk` calls.** Tempting (would let us set
  `cache_control` explicitly), but the SDK already auto-caches and
  it gives us tool-loop handling for free. Re-evaluate only if
  unified mode hits an SDK-imposed wall.
- **Make the runner agent-agnostic** (gpt-4-via-OpenAI, etc.).
  Cezar's value proposition is "Claude-best autofix"; the runner is
  Claude-shaped on purpose.
- **Per-token streaming to the cockpit before Phase D.** Today's
  per-event polling is fine until we have the long stream to render.

## 11. The first test that should pass

Phase A test (single workspace, single run):

```
GIVEN config.autofix.runner.transport = 'stream-json'
WHEN autofix runs on issue #1950
THEN the run completes in less than 8 minutes
  AND the four agent_runs rows are present
  AND the final workflow_runs.status = 'pr-opened' or 'failed'
  AND grep "spawn claude" in the runner stderr returns 1 (not 4)
```

Phase B test:

```
GIVEN config.autofix.runner.mode = 'unified'
WHEN autofix runs on issue #1950
THEN the run completes in less than 5 minutes
  AND cost-weighted tokens are < 200k (vs ~470k staged)
  AND the four agent_runs rows are present, all sharing the same session_id
  AND grep "spawn claude" returns 1
```

These are the load-bearing assertions — if they don't hold, the
refactor's premise is wrong and we should bail before Phase C.
