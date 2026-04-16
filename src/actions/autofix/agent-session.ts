import { z } from 'zod';
import { query, type SDKMessage, type QueryOptions } from '@anthropic-ai/claude-agent-sdk';
import { TokenBudget, TokenBudgetExceededError } from './token-budget.js';

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
}

export interface AgentSessionOptions<T = unknown> {
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  allowedTools: string[];
  bashAllowlist?: string[];
  additionalDirectories?: string[];
  responseSchema?: z.ZodSchema<T>;
  model?: string;
  maxTurns?: number;
  tokenBudget?: TokenBudget;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; result: string; isError: boolean }
  | { type: 'budget-exceeded'; used: number; limit: number }
  | { type: 'turn-end'; tokensUsed: number };

export interface AgentSessionResult<T = unknown> {
  text: string;
  parsed: T | null;
  toolCalls: ToolCallRecord[];
  tokensUsed: number;
  budgetExceeded: boolean;
}

/**
 * Drive one Claude Agent SDK session. Enforces the tool allowlist, bash command
 * allowlist, and token budget. Returns the collected text, any tool calls, and
 * (if `responseSchema` was supplied) a parsed structured result.
 */
export async function runAgentSession<T = unknown>(
  opts: AgentSessionOptions<T>,
): Promise<AgentSessionResult<T>> {
  const toolCalls: ToolCallRecord[] = [];
  const textChunks: string[] = [];
  let tokensUsed = 0;
  let budgetExceeded = false;

  const canUseTool: QueryOptions['canUseTool'] = async (toolName, input) => {
    if (!opts.allowedTools.includes(toolName)) {
      return { behavior: 'deny', message: `Tool '${toolName}' is not on the allowlist` };
    }
    if (toolName === 'Bash' && opts.bashAllowlist) {
      const cmd = extractBashCommand(input);
      if (!cmd || !isBashCommandAllowed(cmd, opts.bashAllowlist)) {
        return {
          behavior: 'deny',
          message: `Bash command '${cmd ?? '(missing)'}' is not on the allowlist. ` +
            `Allowed: ${opts.bashAllowlist.join(', ')}`,
        };
      }
    }
    return { behavior: 'allow' };
  };

  const queryOpts: QueryOptions = {
    cwd: opts.cwd,
    systemPrompt: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    additionalDirectories: opts.additionalDirectories,
    maxTurns: opts.maxTurns ?? 40,
    permissionMode: 'default',
    canUseTool,
  };
  if (opts.model) queryOpts.model = opts.model;

  const iter = query({ prompt: opts.userPrompt, options: queryOpts });

  // Guard against stray transport errors from the SDK's subprocess (e.g.
  // ERR_STREAM_WRITE_AFTER_END after the agent terminated) — those are
  // emitted as Node 'error' events on the underlying socket and would
  // otherwise crash the whole CLI before we could return gracefully.
  let sawTerminalMessage = false;
  const stashedExceptionHandler = (err: Error): void => {
    if (err && (err as NodeJS.ErrnoException).code === 'ERR_STREAM_WRITE_AFTER_END') return;
    throw err;
  };
  process.on('uncaughtException', stashedExceptionHandler);

  try {
    for await (const msg of iter) {
      processMessage(msg, { toolCalls, textChunks, onEvent: opts.onEvent });
      if ((msg as { type?: string }).type === 'result') {
        sawTerminalMessage = true;
      }

      const delta = extractUsage(msg);
      if (delta > 0) {
        tokensUsed += delta;
        if (opts.tokenBudget) {
          opts.tokenBudget.record({ inputTokens: delta });
          opts.onEvent?.({ type: 'turn-end', tokensUsed });
          try {
            opts.tokenBudget.assertWithinBudget();
          } catch (err) {
            if (err instanceof TokenBudgetExceededError) {
              budgetExceeded = true;
              opts.onEvent?.({ type: 'budget-exceeded', used: err.used, limit: err.limit });
              // Only call interrupt() if the stream hasn't already finished.
              // Interrupt writes to the subprocess stdin; doing so after the
              // terminal 'result' message causes ERR_STREAM_WRITE_AFTER_END.
              if (!sawTerminalMessage) {
                try { await iter.interrupt(); } catch { /* SDK already closed */ }
              }
              break;
            }
            throw err;
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof TokenBudgetExceededError) {
      budgetExceeded = true;
    } else {
      throw err;
    }
  } finally {
    process.off('uncaughtException', stashedExceptionHandler);
  }

  const text = textChunks.join('\n').trim();
  const parsed = opts.responseSchema ? parseStructured(text, opts.responseSchema) : null;

  return { text, parsed, toolCalls, tokensUsed, budgetExceeded };
}

function processMessage(
  msg: SDKMessage,
  ctx: { toolCalls: ToolCallRecord[]; textChunks: string[]; onEvent?: (e: AgentEvent) => void },
): void {
  const m = msg as { type: string; message?: { content?: unknown[]; role?: string } };
  if (!m.message?.content) return;

  for (const block of m.message.content) {
    const b = block as {
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };

    if (m.type === 'assistant' && b.type === 'text' && typeof b.text === 'string') {
      ctx.textChunks.push(b.text);
      ctx.onEvent?.({ type: 'text', text: b.text });
    } else if (m.type === 'assistant' && b.type === 'tool_use' && b.id && b.name) {
      ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
      ctx.onEvent?.({ type: 'tool', tool: b.name, input: b.input });
    } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      ctx.onEvent?.({
        type: 'tool-result',
        toolUseId: b.tool_use_id,
        result: stringifyToolResult(b.content),
        isError: b.is_error === true,
      });
    }
  }
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      const block = c as { type?: string; text?: string };
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      try { return JSON.stringify(block); } catch { return String(block); }
    }).join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

// Anthropic bills cache-read input at ~10% of standard input cost and cache
// creation at ~125%. Weighting the raw token counts by these multipliers keeps
// the budget roughly proportional to dollar cost rather than raw token volume.
const CACHE_READ_WEIGHT = 0.1;
const CACHE_CREATION_WEIGHT = 1.25;

function extractUsage(msg: SDKMessage): number {
  const m = msg as { message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
  const usage = m.message?.usage ?? m.usage;
  if (!usage) return 0;
  return Math.round(
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) * CACHE_CREATION_WEIGHT +
    (usage.cache_read_input_tokens ?? 0) * CACHE_READ_WEIGHT,
  );
}

function extractBashCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd.trim() : null;
}

function isBashCommandAllowed(cmd: string, allowlist: string[]): boolean {
  const normalized = cmd.replace(/\s+/g, ' ').trim();
  return allowlist.some(allowed => {
    const a = allowed.trim();
    return normalized === a || normalized.startsWith(`${a} `) || normalized.startsWith(`${a}`);
  });
}

function parseStructured<T>(raw: string, schema: z.ZodSchema<T>): T | null {
  const cleaned = raw.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  try {
    return schema.parse(JSON.parse(cleaned));
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return schema.parse(JSON.parse(match[0]));
    } catch {
      return null;
    }
  }
}
