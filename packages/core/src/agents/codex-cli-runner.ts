import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TokenBudgetExceededError } from '../actions/autofix/token-budget.js';
import {
  type AgentRunner,
  type AgentRunSpec,
  type AgentRunResult,
  type AgentEvent,
  type AgentToolCallRecord,
} from './agent-runner.js';
import { parseStructured } from './structured-output.js';
import type { SpawnFn } from './claude-cli-runner.js';

export interface CodexCliRunnerOptions {
  /** Override the binary name/path; defaults to `codex` on PATH. */
  bin?: string;
  spawnFn?: SpawnFn;
}

/**
 * `AgentRunner` over the OpenAI Codex CLI in non-interactive mode
 * (`codex exec --json`). Auth = the host's ChatGPT subscription / Codex login.
 *
 * HIGHEST-RISK BACKEND. Codex's headless + structured-output story is the
 * least mature of the three: the `--json` event schema is less documented than
 * Claude's stream-json, `--output-schema` enforcement is newish, and there is
 * no per-tool allowlist hook — sandboxing is the coarse `-s <mode>` plus a
 * worktree-only `--cd`. The Phase 0 gate explicitly allows shipping without
 * this backend (escape hatch) if live verification fails.
 *
 * TODO(phase-0): every flag and event-type name below is derived from
 * `codex exec --help` (v0.128) + the documented `codex exec --json` interface,
 * NOT from a live transcript. Re-verify against a real run in Phase 4 — in
 * particular the event envelope shape and which event carries token usage.
 */
export class CodexCliRunner implements AgentRunner {
  readonly backend = 'codex-cli' as const;

  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(opts: CodexCliRunnerOptions = {}) {
    this.bin = opts.bin ?? 'codex';
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  }

  async run<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>> {
    const args = buildCodexArgs(spec);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnFn(this.bin, args, { cwd: spec.cwd, env: process.env });
    } catch (err) {
      throw wrapSpawnError(err, this.bin);
    }
    this.child = child;

    const toolCalls: AgentToolCallRecord[] = [];
    const textChunks: string[] = [];
    let tokensUsed = 0;
    let budgetExceeded = false;
    let spawnFailed: Error | null = null;

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnFailed = wrapSpawnError(err, this.bin);
    });

    const stderrChunks: string[] = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

    try {
      for await (const line of readNdjson(child.stdout)) {
        let evt: CodexEvent;
        try {
          evt = JSON.parse(line) as CodexEvent;
        } catch {
          onEvent?.({ type: 'note', message: line });
          continue;
        }

        const delta = handleCodexEvent(evt, { toolCalls, textChunks, onEvent });
        if (delta > 0) {
          tokensUsed += delta;
          if (spec.tokenBudget) {
            spec.tokenBudget.record({ inputTokens: delta });
            onEvent?.({ type: 'token-usage', tokensUsed });
            try {
              spec.tokenBudget.assertWithinBudget();
            } catch (err) {
              if (err instanceof TokenBudgetExceededError) {
                budgetExceeded = true;
                onEvent?.({ type: 'note', message: `token budget exceeded: used ${err.used} of ${err.limit}` });
                await this.interrupt();
                break;
              }
              throw err;
            }
          }
        }
      }
    } finally {
      this.child = null;
    }

    const exitCode = await waitForExit(child);

    if (spawnFailed) throw spawnFailed;
    if (!budgetExceeded && exitCode !== 0 && exitCode !== null) {
      const stderr = stderrChunks.join('').trim();
      const detail = stderr ? ` — ${stderr.split('\n').slice(-3).join(' | ')}` : '';
      const msg = `codex CLI exited with code ${exitCode}${detail}`;
      onEvent?.({ type: 'error', message: msg });
      throw new Error(msg);
    }

    onEvent?.({ type: 'done' });

    const text = textChunks.join('\n').trim();
    const parsed = spec.responseSchema ? parseStructured(text, spec.responseSchema) : null;

    return { text, parsed, toolCalls, tokensUsed, budgetExceeded };
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) return;
    child.kill('SIGTERM');
  }
}

/**
 * Build the `codex exec` argv. `--json` gives the JSONL event stream;
 * `--skip-git-repo-check` avoids a hard failure when the worktree isn't a repo
 * root; `--cd` pins the working root; `-s workspace-write` keeps writes inside
 * the workspace (Codex has no per-tool allowlist — this is the sandbox);
 * `-m` sets the model; the prompt is the trailing positional.
 */
function buildCodexArgs<T>(spec: AgentRunSpec<T>): string[] {
  const args: string[] = ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write'];
  // `--cd` makes the agent's working root explicit even though we also pass
  // `cwd` to spawn — keeps behavior stable if Codex resolves paths oddly.
  args.push('--cd', spec.cwd);
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  if (spec.model) {
    args.push('-m', spec.model);
  }
  // Codex prepends the system prompt as instruction context; there's no
  // dedicated `--append-system-prompt`, so fold it into the prompt body with a
  // clear header. TODO(phase-0): if Codex grows a system-prompt flag, use it.
  const prompt = spec.systemPrompt.trim()
    ? `${spec.systemPrompt.trim()}\n\n---\n\n${spec.userPrompt}`
    : spec.userPrompt;
  // TODO(phase-0): `--output-schema <file>` could enforce the response shape;
  // skipped for now (would require writing a temp file) — we extract from the
  // final agent message via parseStructured, matching the other backends.
  args.push(prompt);
  return args;
}

// ---- codex event handling -------------------------------------------------

/**
 * Loosely-typed Codex `exec --json` event. The CLI emits one JSON object per
 * line; observed/expected envelopes are either `{type, ...}` flat or
 * `{id, msg: {type, ...}}`. We handle both and ignore unknown types.
 */
interface CodexEvent {
  type?: string;
  id?: string;
  msg?: { type?: string; [k: string]: unknown };
  // Common payload fields across envelope styles:
  message?: string;
  text?: string;
  delta?: string;
  command?: string | string[];
  output?: string;
  exit_code?: number;
  error?: string;
  // token usage variants
  total_token_usage?: { total_tokens?: number; input_tokens?: number; output_tokens?: number };
  info?: { total_token_usage?: { total_tokens?: number } };
  total_tokens?: number;
  [k: string]: unknown;
}

function handleCodexEvent(
  evt: CodexEvent,
  ctx: { toolCalls: AgentToolCallRecord[]; textChunks: string[]; onEvent?: (e: AgentEvent) => void },
): number {
  const inner = evt.msg && typeof evt.msg === 'object' ? evt.msg : evt;
  const type = String((inner as { type?: unknown }).type ?? evt.type ?? '');
  const get = (k: string): unknown => (inner as Record<string, unknown>)[k] ?? (evt as Record<string, unknown>)[k];

  switch (type) {
    // Final / streamed assistant message text.
    case 'agent_message':
    case 'agent_message_delta':
    case 'agent_reasoning': {
      const text = (get('message') ?? get('text') ?? get('delta')) as string | undefined;
      if (typeof text === 'string' && text.length > 0 && type !== 'agent_message_delta') {
        // Deltas are streamed-but-incomplete; only the consolidated
        // `agent_message` is recorded as canonical text. Both are surfaced as
        // `text` events for live display.
        ctx.textChunks.push(text);
      }
      if (typeof text === 'string' && text.length > 0) {
        ctx.onEvent?.({ type: 'text', text });
      }
      return 0;
    }

    // Shell command execution = Codex's analogue of a tool call.
    case 'exec_command_begin':
    case 'command_execution_begin': {
      const cmd = get('command');
      const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
      const id = String(evt.id ?? `codex-cmd-${ctx.toolCalls.length}`);
      ctx.toolCalls.push({ id, name: 'Bash', input: { command: cmdStr } });
      ctx.onEvent?.({ type: 'tool-call', id, tool: 'Bash', input: { command: cmdStr } });
      return 0;
    }
    case 'exec_command_end':
    case 'command_execution_end': {
      const id = String(evt.id ?? '');
      const output = (get('output') ?? get('stdout') ?? '') as string;
      const code = Number(get('exit_code') ?? 0);
      ctx.onEvent?.({
        type: 'tool-result',
        toolCallId: id || (ctx.toolCalls.at(-1)?.id ?? ''),
        result: typeof output === 'string' ? output : JSON.stringify(output),
        isError: code !== 0,
      });
      return 0;
    }

    // File patch applied — also a "tool" effect.
    case 'patch_apply_begin':
    case 'apply_patch_begin': {
      const id = String(evt.id ?? `codex-patch-${ctx.toolCalls.length}`);
      ctx.toolCalls.push({ id, name: 'Edit', input: get('changes') ?? get('patch') ?? null });
      ctx.onEvent?.({ type: 'tool-call', id, tool: 'Edit', input: get('changes') ?? get('patch') ?? null });
      return 0;
    }

    case 'token_count':
    case 'token_usage': {
      const usage = (get('total_token_usage') ?? evt.total_token_usage ?? evt.info?.total_token_usage) as
        | { total_tokens?: number; input_tokens?: number; output_tokens?: number }
        | undefined;
      const total = usage?.total_tokens ?? Number(get('total_tokens') ?? 0);
      return Number.isFinite(total) && total > 0 ? Math.round(total) : 0;
    }

    case 'error':
    case 'stream_error': {
      const m = (get('message') ?? get('error')) as string | undefined;
      ctx.onEvent?.({ type: 'error', message: m ? `codex: ${m}` : 'codex reported an error event' });
      return 0;
    }

    case 'task_complete':
    case 'turn_complete': {
      // Some Codex versions deliver the final answer here rather than via
      // `agent_message` — capture it if we have nothing yet.
      const text = (get('last_agent_message') ?? get('message')) as string | undefined;
      if (typeof text === 'string' && text.length > 0 && ctx.textChunks.length === 0) {
        ctx.textChunks.push(text);
        ctx.onEvent?.({ type: 'text', text });
      }
      return 0;
    }

    default:
      return 0;
  }
}

// ---- subprocess plumbing (shared shape with claude-cli-runner) ------------

async function* readNdjson(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
}

function wrapSpawnError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new Error(
      `${bin} CLI not found on PATH — install the Codex CLI or use the anthropic-api backend`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
