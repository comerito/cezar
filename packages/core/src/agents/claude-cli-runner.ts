import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TokenBudgetExceededError } from '../actions/autofix/token-budget.js';
import {
  type AgentRunner,
  type AgentRunSpec,
  type AgentRunResult,
  type AgentEvent,
  type AgentToolCallRecord,
} from './agent-runner.js';
import { costWeightedTokens, parseStructured, type RawUsage } from './structured-output.js';

/** Injectable for tests — same shape as `node:child_process.spawn`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export interface ClaudeCodeCliRunnerOptions {
  /** Override the binary name/path; defaults to `claude` on PATH. */
  bin?: string;
  spawnFn?: SpawnFn;
}

/**
 * `AgentRunner` over the Claude Code CLI in headless mode (`claude -p`). Auth =
 * the host's logged-in Pro/Max subscription (no API key needed). Tool/cwd
 * sandboxing is delegated to `--allowedTools` + a worktree-only `cwd` (the SDK
 * `canUseTool` hook isn't available here).
 *
 * TODO(phase-0): the exact flag set below was derived from `claude --help` on
 * the dev box (v2.x). Re-verify against the runner's installed Claude Code
 * version in Phase 4 — `--permission-mode acceptEdits` and the `stream-json`
 * event schema in particular.
 */
export class ClaudeCodeCliRunner implements AgentRunner {
  readonly backend = 'claude-cli' as const;

  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private child: ChildProcessWithoutNullStreams | null = null;

  constructor(opts: ClaudeCodeCliRunnerOptions = {}) {
    this.bin = opts.bin ?? 'claude';
    this.spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  }

  async run<T = unknown>(
    spec: AgentRunSpec<T>,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult<T>> {
    const args = buildClaudeArgs(spec);

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
        let msg: ClaudeStreamMessage;
        try {
          msg = JSON.parse(line) as ClaudeStreamMessage;
        } catch {
          // Non-JSON noise on the stream — surface it but keep going.
          onEvent?.({ type: 'note', message: line });
          continue;
        }

        const delta = handleClaudeMessage(msg, { toolCalls, textChunks, onEvent });
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
      const msg = `claude CLI exited with code ${exitCode}${detail}`;
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
    // Headless `claude -p` has no in-band interrupt; SIGTERM is the cooperative
    // stop. A hard SIGKILL fallback (for cancellation) belongs in the runner
    // layer (Phase 4), not here.
    child.kill('SIGTERM');
  }
}

/**
 * Build the headless `claude` argv. `-p` selects print/headless mode;
 * `--output-format stream-json --verbose` gives us the per-event NDJSON stream;
 * `--append-system-prompt` keeps the default Claude Code system prompt and adds
 * our step prompt on top; `--allowedTools` is the sandbox; `--permission-mode
 * acceptEdits` lets edits through without a prompt (there's no TTY).
 */
function buildClaudeArgs<T>(spec: AgentRunSpec<T>): string[] {
  const args: string[] = [
    '-p',
    spec.userPrompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--append-system-prompt',
    spec.systemPrompt,
    '--permission-mode',
    'acceptEdits',
  ];
  if (spec.allowedTools.length > 0) {
    args.push('--allowedTools', spec.allowedTools.join(','));
  }
  // Bash allowlist → scoped Bash tool patterns when supported by the CLI's
  // `Bash(prefix *)` syntax; we still record + (best-effort) verify post-hoc.
  if (spec.model) {
    args.push('--model', spec.model);
  }
  // TODO(phase-0): the headless CLI exposes no `--max-turns` equivalent
  // (only `--max-budget-usd`). `spec.maxTurns` is currently ignored for this
  // backend; revisit if the CLI grows a turn cap, otherwise rely on the budget.
  for (const dir of spec.additionalDirectories ?? []) {
    args.push('--add-dir', dir);
  }
  // TODO(phase-0): `--json-schema` could enforce structured output server-side;
  // for now we extract from the final assistant text via parseStructured so the
  // behavior matches the API path. Revisit when wiring real bindings.
  return args;
}

// ---- stream-json event handling -------------------------------------------

interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  message?: {
    role?: string;
    content?: unknown[];
    usage?: RawUsage;
  };
  // `result` messages carry these at the top level.
  result?: string;
  usage?: RawUsage;
  is_error?: boolean;
  total_cost_usd?: number;
}

function handleClaudeMessage(
  msg: ClaudeStreamMessage,
  ctx: { toolCalls: AgentToolCallRecord[]; textChunks: string[]; onEvent?: (e: AgentEvent) => void },
): number {
  if (msg.type === 'assistant' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        ctx.textChunks.push(b.text);
        ctx.onEvent?.({ type: 'text', text: b.text });
      } else if (b.type === 'tool_use' && b.id && b.name) {
        ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
        ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
      }
    }
    return costWeightedTokens(msg.message.usage);
  }

  if (msg.type === 'user' && msg.message?.content) {
    for (const block of msg.message.content) {
      const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        ctx.onEvent?.({
          type: 'tool-result',
          toolCallId: b.tool_use_id,
          result: stringifyContent(b.content),
          isError: b.is_error === true,
        });
      }
    }
    return 0;
  }

  if (msg.type === 'result') {
    // Final message: `result` is the full assistant text; only fall back to it
    // if we never saw streamed assistant text blocks.
    if (typeof msg.result === 'string' && ctx.textChunks.length === 0) {
      ctx.textChunks.push(msg.result);
      ctx.onEvent?.({ type: 'text', text: msg.result });
    }
    if (msg.is_error) {
      ctx.onEvent?.({ type: 'note', message: `claude reported result error${msg.subtype ? ` (${msg.subtype})` : ''}` });
    }
    return costWeightedTokens(msg.usage);
  }

  // system/init and anything else: nothing actionable.
  return 0;
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        try {
          return JSON.stringify(b);
        } catch {
          return String(b);
        }
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// ---- subprocess plumbing --------------------------------------------------

/** Async line iterator over a readable stream of UTF-8 NDJSON. */
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
      `${bin} CLI not found on PATH — install Claude Code or use the anthropic-api backend`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}
