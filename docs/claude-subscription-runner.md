# How github-janitor runs Claude Code on a subscription

A precise reference of how this project spawns the `claude` CLI so that work
runs against the host user's existing Claude Code subscription — no API key,
no Bedrock, no SDK. The whole mechanism is one `child_process.spawn` call in
`src/lib/claudeRunner.ts`.

This document is meant to be copied into another project as a recipe.

---

## TL;DR

Janitor doesn't authenticate to Anthropic itself. It assumes the host user
has already run `claude auth` once, so `~/.claude/` contains the OAuth
credentials for the Claude Code subscription. Janitor then spawns the
`claude` binary with `child_process.spawn`, **inheriting `process.env`**,
which is enough for the CLI to pick up that login. The "subscription" is
whatever `claude` is already logged in as on the host.

This is documented as a hard prerequisite in `README.md:14`:

> `claude` (Claude Code CLI) installed and authenticated (`claude auth`).

---

## The spawn call (the part to copy)

All of it lives in `src/lib/claudeRunner.ts`:

- Arg construction — `src/lib/claudeRunner.ts:67-86`
- Env pass-through — `src/lib/claudeRunner.ts:87-93`
- Child spawn — `src/lib/claudeRunner.ts:105-109`

### Command shape

```
claude
  --session-id <task-uuid>            # pins session so operator can `claude --resume <uuid>` later
  --output-format stream-json         # NDJSON on stdout
  --input-format  stream-json         # NDJSON on stdin (no -p, so it stays alive between turns)
  --permission-mode bypassPermissions # default; configurable
  [--allowed-tools <pattern> ...]
  [--disallowed-tools <pattern> ...]
  --verbose
  [--append-system-prompt "<persona>"]
  --model <sonnet|opus|haiku|...>
  [--max-budget-usd <n>]
  --add-dir <worktree-path>
```

### Node spawn

```js
import { spawn } from "node:child_process";

const child = spawn("claude", args, {
  cwd: worktreePath,             // per-task working directory
  env: {                          // <-- THIS is how subscription auth flows in
    ...process.env,
    JANITOR_TASK_ID: task.id,
    JANITOR_DRY_RUN: dry ? "1" : "0",
    GH_DRY_RUN:      dry ? "1" : "0",
    DRY_RUN:         dry ? "1" : "0"
  },
  stdio: ["pipe", "pipe", "pipe"]
});
```

### Two non-obvious choices

1. **No `-p` / no `--print`.** Print mode runs one turn and exits. By passing
   `--input-format stream-json` *without* `-p`, the process stays alive
   indefinitely; janitor sends the initial prompt and any follow-ups by
   writing newline-delimited JSON to stdin
   (`src/lib/claudeRunner.ts:391-410`).
2. **`...process.env`** — the whole subscription story is this pass-through.
   `HOME` is inherited → `~/.claude/` is found → the CLI's existing OAuth
   session is used. Janitor never sets `ANTHROPIC_API_KEY`,
   `CLAUDE_CODE_USE_BEDROCK`, or any other auth env var. (Grep `src/`,
   `scripts/`, `SPEC.md`, `README.md` — zero references.)

---

## Sending a user message mid-session

Stream-json user messages are written to the child's stdin
(`src/lib/claudeRunner.ts:391-410`), one JSON object per line, `\n`-terminated:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "<follow-up text>" }]
  },
  "session_id": "<task-uuid>"
}
```

The first write seeds the conversation with the resolved prompt; subsequent
writes are follow-ups from the operator. Image blocks are supported the same
way (`{ "type": "image", "source": { "type": "base64", "media_type": "...", "data": "..." } }`).

---

## Reading the output

stdout is parsed line-by-line into `AgentEvent`s
(`src/lib/claudeRunner.ts:153-192`); the mapping logic is at
`src/lib/claudeRunner.ts:265-352`. The mapper handles the following envelope
types emitted by the CLI:

| `json.type`     | Meaning                                              |
| --------------- | ---------------------------------------------------- |
| `system` (init) | Initial banner — model, cwd, session_id              |
| `assistant`     | Assistant turn — text blocks and `tool_use` blocks   |
| `user`          | Tool-result echo                                     |
| `stream_event`  | Token-level deltas (filtered to `text_delta` only)   |
| `result`        | End-of-turn marker carrying `total_cost_usd`, `usage` |

A `result` line flips the task to `done` (or `failed` if `is_error`) while
keeping the child alive so follow-ups remain possible
(`src/lib/claudeRunner.ts:163-173`).

Raw bytes are also tee'd to `<id>.raw.log` (`src/lib/claudeRunner.ts:149-151`)
for forensic debugging.

---

## Per-task isolation (why janitor exists)

Each task runs in its own git worktree off a bare clone
(`src/lib/git.ts:108-131`):

```
.janitor/repos/<owner>__<name>/.bare/                # bare clone
.janitor/repos/<owner>__<name>/worktrees/<uuid>/     # per-task worktree, branch task/<uuid>
```

`claude` is `cwd`-ed into the worktree, so the repo's own
`.claude/commands/*.md`, `.claude/skills/*/SKILL.md`, `CLAUDE.md`, hooks, and
agents become the active configuration. Multiple tasks run in parallel
without stepping on each other.

The session id passed via `--session-id` equals the task UUID, which is what
makes `cd <worktree> && claude --resume <task-uuid>` work for the operator to
take over interactively later.

---

## Concurrency control

- Running children are tracked in a `Map` pinned on `globalThis` so Next.js
  hot reload doesn't orphan them (`src/lib/claudeRunner.ts:29-31`).
- Parallelism is capped by `cfg.defaults.maxParallel`
  (`src/lib/tasks.ts:358-389`); the pump dequeues only when there's headroom.

---

## Dry-run swap

When `DRY_RUN=1` (env) or `task.dryRun` is set, the `claude` binary is
replaced with `node scripts/mock-claude.mjs`
(`src/lib/claudeRunner.ts:95-103`). The mock honours the same stdio contract
(reads stream-json from stdin, emits stream-json on stdout) so the rest of
the pipeline is unchanged and no subscription tokens are consumed.

---

## Periodic autosave

While a task is running, a 90-second interval timer commits the worktree's
working tree (`src/lib/claudeRunner.ts:130-134`, implementation at
`src/lib/git.ts:156-189`). A final commit runs on child `close`
(`src/lib/claudeRunner.ts:228-234`). Commits use the `gh`-authenticated
identity so they attribute correctly when the branch is pushed.

---

## Minimum recipe for another project

To replicate the subscription-driven runner elsewhere, you need:

### 1. Host requirement

- `claude` CLI installed.
- `claude auth` completed once on the host.
- Same OS user that will own the long-running server process.

### 2. Spawn template

Copy the call from `src/lib/claudeRunner.ts:67-109` almost verbatim. The
non-negotiable parts:

- `--session-id <stable-id>` — pin your own ID so `claude --resume` works.
- `--output-format stream-json --input-format stream-json` — and **no `-p`**.
- `cwd` set to a per-task working directory (worktree if you want parallelism).
- `env: { ...process.env, ... }` — do **not** sanitize `HOME`,
  `XDG_CONFIG_HOME`, or `PATH`. Those are how the subscription is found.
- `stdio: ["pipe", "pipe", "pipe"]` — you write JSON to stdin and parse JSON
  from stdout.

### 3. stdin protocol

Newline-delimited JSON, one user message per line, shape shown above. First
write seeds the conversation; subsequent writes are follow-ups.

### 4. stdout parser

```js
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const json = JSON.parse(line);
      handle(json);   // branch on json.type as in claudeRunner.ts:265-352
    } catch {
      /* non-JSON line — surface as stderr/system event */
    }
  }
});
```

The branches at `src/lib/claudeRunner.ts:265-352` cover every envelope the
CLI emits today.

### 5. Lifecycle hooks

The runner cares about four child events:

| Event   | What to do                                                    |
| ------- | ------------------------------------------------------------- |
| `data`  | Parse line, persist event, fan out to UI                      |
| `error` | Record as an error event                                      |
| `close` | Record `exitCode` + `finishedAt`, run cleanup, drop from Map  |
| —       | A `json.type === "result"` line marks **turn complete** while the process stays alive (`claudeRunner.ts:163-173`) |

---

## The one-line answer

The single line that makes "subscription auth just works" is
`env: { ...process.env, ... }` at `src/lib/claudeRunner.ts:87-93`. Drop that
pass-through and you'd need an API key.

---

## Reference: full arg builder

For convenience, the verbatim arg-construction block from
`src/lib/claudeRunner.ts:67-86`:

```ts
const args: string[] = [];
args.push("--session-id", task.id);
args.push("--output-format", "stream-json");
args.push("--input-format", "stream-json");
args.push("--permission-mode", cfg.defaults.permissionMode);
for (const pat of cfg.defaults.allowedTools ?? []) {
  if (pat.trim()) args.push("--allowed-tools", pat.trim());
}
for (const pat of cfg.defaults.disallowedTools ?? []) {
  if (pat.trim()) args.push("--disallowed-tools", pat.trim());
}
args.push("--verbose");
if (cfg.defaults.personaPrompt?.trim()) {
  args.push("--append-system-prompt", cfg.defaults.personaPrompt.trim());
}
args.push("--model", task.model || cfg.defaults.model || "sonnet");
if (cfg.defaults.maxBudgetUsd != null)
  args.push("--max-budget-usd", String(cfg.defaults.maxBudgetUsd));
args.push("--add-dir", task.worktreePath);
```
