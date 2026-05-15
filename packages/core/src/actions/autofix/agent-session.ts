import type { z } from 'zod';
import type { TokenBudget } from './token-budget.js';
import { AnthropicApiRunner } from '../../agents/anthropic-api-runner.js';
import type { AgentEvent as NormalizedAgentEvent } from '../../agents/agent-runner.js';
import { parseStructured } from '../../agents/structured-output.js';

export { parseStructured };

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

/**
 * The original (pre-`AgentRunner`) event shape. Kept verbatim so the CLI's
 * verbose trace and the GUI event bridge keep working unchanged. New code
 * should consume `AgentEvent` from `../../agents/agent-runner.js` instead.
 */
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
 * Thin compatibility shim over `AnthropicApiRunner`. Preserves the exact old
 * signature and return shape; the orchestrator and the autofix tests rely on
 * it. The body now lives in `packages/core/src/agents/anthropic-api-runner.ts`.
 */
export async function runAgentSession<T = unknown>(
  opts: AgentSessionOptions<T>,
): Promise<AgentSessionResult<T>> {
  const runner = new AnthropicApiRunner();

  const onEvent = opts.onEvent;
  const bridge = onEvent
    ? (e: NormalizedAgentEvent): void => {
        const mapped = toLegacyEvent(e, opts.tokenBudget);
        if (mapped) onEvent(mapped);
      }
    : undefined;

  const result = await runner.run<T>(
    {
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      bashAllowlist: opts.bashAllowlist,
      additionalDirectories: opts.additionalDirectories,
      model: opts.model,
      maxTurns: opts.maxTurns,
      tokenBudget: opts.tokenBudget,
      responseSchema: opts.responseSchema,
    },
    bridge,
  );

  return {
    text: result.text,
    parsed: result.parsed,
    toolCalls: result.toolCalls,
    tokensUsed: result.tokensUsed,
    budgetExceeded: result.budgetExceeded,
  };
}

/** Map a normalized runner event back to the legacy `AgentEvent` shape. */
function toLegacyEvent(e: NormalizedAgentEvent, budget?: TokenBudget): AgentEvent | null {
  switch (e.type) {
    case 'text':
      return { type: 'text', text: e.text };
    case 'tool-call':
      return { type: 'tool', tool: e.tool, input: e.input };
    case 'tool-result':
      return { type: 'tool-result', toolUseId: e.toolCallId, result: e.result, isError: e.isError };
    case 'token-usage':
      return { type: 'turn-end', tokensUsed: e.tokensUsed };
    case 'note':
      // The only `note` the API runner emits is the budget-exceeded notice;
      // reconstruct the old structured event from the live budget.
      if (budget && budget.exceeded) {
        return { type: 'budget-exceeded', used: budget.current, limit: budget.limit };
      }
      return null;
    case 'done':
    case 'error':
      return null;
  }
}
