import Anthropic from '@anthropic-ai/sdk';
import type { ActionDef, ActionRunResult } from './action.js';
import type { Skill } from '../skills/skill-catalog.js';
import { actionAlreadyCommented, buildAutoCommentBody } from './auto-comment.js';
import {
  ALL_EFFECT_NAMES,
  EFFECT_REGISTRY,
  effectsAsAnthropicTools,
  executeEffect,
  type EffectCall,
  type EffectContext,
  type EffectName,
} from './effects.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 8;

/**
 * The single payload describing the entity (issue or PR) an action targets.
 * The runner does not fetch this — callers (cron / webhook handlers / GUI)
 * pass it in. Keeping the runner pure simplifies testing.
 */
export interface ActionTarget {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  htmlUrl: string;
  /** Optional pre-formatted comment context the runner can include. */
  comments?: string;
}

export interface RunActionDeps {
  /** Resolved skill catalog the runner uses to look up `skill_refs`. */
  skills: Skill[];
  /** Anthropic client. Caller can pass a custom instance for testing. */
  anthropic?: Anthropic;
  /** Effect context — passed through to effect executors when they fire. */
  effectCtx: EffectContext;
  /** Override the model for this run. Defaults to claude-sonnet-4-6. */
  model?: string;
  /** Auto-comment behaviour. When `enabled`, the runner posts a
   *  Cezar-branded summary comment after a successful run — unless the
   *  action itself already posted one via the `comment` effect. */
  autoComment?: {
    enabled: boolean;
    triggeredBy?: string;
  };
}

/**
 * Run a single Action against a single target. Dispatches on the action's
 * `effects` field:
 *
 *  - `effects != null` → "declared" mode. We ask for a JSON response shaped
 *    `{ effects: EffectCall[] }`, parse it, and execute the listed effects
 *    in order. The response also includes a `summary` field that we keep as
 *    the run's text output.
 *  - `effects == null` → "tool-use" mode. We hand the model the effect
 *    vocabulary as Anthropic tools and let it decide which to call mid-run.
 *    We iterate the tool-use loop until the model produces a final text
 *    response (max 8 iterations to bound runaway runs).
 */
export async function runAction(
  action: ActionDef,
  target: ActionTarget,
  deps: RunActionDeps,
): Promise<ActionRunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = deps.anthropic ?? new Anthropic({ apiKey });

  const skillSection = resolveSkillContext(action.skillRefs, deps.skills);
  const systemMessage = [
    action.systemPrompt.trim(),
    skillSection,
  ]
    .filter((s) => s && s.length > 0)
    .join('\n\n---\n\n');

  const userMessage = formatTarget(target);
  const model = deps.model ?? DEFAULT_MODEL;

  const result = action.effects && action.effects.length > 0
    ? await runDeclaredMode(action, target, {
        client,
        effectCtx: deps.effectCtx,
        model,
        systemMessage,
        userMessage,
      })
    : await runToolUseMode(action, target, {
        client,
        effectCtx: deps.effectCtx,
        model,
        systemMessage,
        userMessage,
      });

  if (deps.autoComment?.enabled && !actionAlreadyCommented(result.effectsApplied)) {
    const body = buildAutoCommentBody({
      actionName: action.name,
      text: result.text,
      effectsApplied: result.effectsApplied,
      meta: {
        actionName: action.name,
        triggeredBy: deps.autoComment.triggeredBy,
        model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    });
    try {
      await deps.effectCtx.github.addComment(deps.effectCtx.targetNumber, body);
      result.effectsApplied.push({
        call: { effect: 'comment', args: { body } },
        summary: `auto-commented on #${deps.effectCtx.targetNumber}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.effectsApplied.push({
        call: { effect: 'comment', args: { body } },
        summary: `auto-comment failed: ${message}`,
      });
    }
  }

  return result;
}

// ─── Declared mode (structured JSON response) ──────────────────────────────

interface RunMode {
  client: Anthropic;
  effectCtx: EffectContext;
  model: string;
  systemMessage: string;
  userMessage: string;
}

async function runDeclaredMode(
  action: ActionDef,
  _target: ActionTarget,
  mode: RunMode,
): Promise<ActionRunResult> {
  const effectNames = action.effects ?? [];
  const declaredEffectsHint = describeDeclaredEffects(effectNames);

  const resp = await mode.client.messages.create({
    model: mode.model,
    max_tokens: MAX_TOKENS,
    system: `${mode.systemMessage}\n\n${declaredEffectsHint}`,
    messages: [{ role: 'user', content: mode.userMessage }],
  });

  const text = extractText(resp);
  const parsed = parseDeclaredResponse(text);

  const effectsApplied: Array<{ call: EffectCall; summary: string }> = [];
  for (const call of parsed.effects) {
    // Reject calls that the action didn't declare — the user said "this
    // action will only ever do X, Y", and we enforce that even if the model
    // tries to expand.
    if (!effectNames.includes(call.effect)) continue;
    try {
      const summary = await executeEffect(call, mode.effectCtx);
      effectsApplied.push({ call, summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      effectsApplied.push({ call, summary: `error: ${message}` });
    }
  }

  return {
    text: parsed.summary ?? text,
    effectsApplied,
    usage: {
      inputTokens: resp.usage?.input_tokens ?? 0,
      outputTokens: resp.usage?.output_tokens ?? 0,
    },
  };
}

function describeDeclaredEffects(effects: EffectName[]): string {
  const lines = effects.map((name) => {
    const def = EFFECT_REGISTRY[name];
    return `- ${name}: ${def.description}`;
  });
  return [
    '## Required response format',
    '',
    'Respond ONLY with valid JSON in this shape — no markdown, no commentary:',
    '',
    '```json',
    '{',
    '  "summary": "one short sentence explaining what you decided",',
    '  "effects": [',
    '    { "effect": "<one of the names below>", "args": { /* args matching that effect\'s schema */ } }',
    '  ]',
    '}',
    '```',
    '',
    'Allowed effects (omit `effects` entirely if the right answer is "do nothing"):',
    ...lines,
  ].join('\n');
}

interface DeclaredResponse {
  summary?: string;
  effects: EffectCall[];
}

function parseDeclaredResponse(text: string): DeclaredResponse {
  const trimmed = text.trim();
  // Tolerate a markdown fence the model may have added despite instructions.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { effects: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { effects: [] };
  const obj = parsed as Record<string, unknown>;
  const effects = Array.isArray(obj.effects)
    ? (obj.effects as unknown[])
        .map((e): EffectCall | null => {
          if (!e || typeof e !== 'object') return null;
          const eo = e as Record<string, unknown>;
          if (typeof eo.effect !== 'string') return null;
          return { effect: eo.effect as EffectName, args: eo.args ?? {} };
        })
        .filter((e): e is EffectCall => e !== null)
    : [];
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    effects,
  };
}

// ─── Tool-use mode (agent calls effects mid-run) ───────────────────────────

async function runToolUseMode(
  _action: ActionDef,
  _target: ActionTarget,
  mode: RunMode,
): Promise<ActionRunResult> {
  const tools = effectsAsAnthropicTools(ALL_EFFECT_NAMES);
  const effectsApplied: Array<{ call: EffectCall; summary: string }> = [];
  let usage = { inputTokens: 0, outputTokens: 0 };

  // Build the running message thread. We mutate `messages` across iterations
  // by appending each assistant turn and the corresponding tool_result.
  type ContentBlock = Record<string, unknown>;
  type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] };
  const messages: Message[] = [{ role: 'user', content: mode.userMessage }];
  let finalText = '';

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const resp = await mode.client.messages.create({
      model: mode.model,
      max_tokens: MAX_TOKENS,
      system: mode.systemMessage,
      tools: tools as unknown as Anthropic.Tool[],
      messages: messages as unknown as Anthropic.MessageParam[],
    });

    usage = {
      inputTokens: usage.inputTokens + (resp.usage?.input_tokens ?? 0),
      outputTokens: usage.outputTokens + (resp.usage?.output_tokens ?? 0),
    };

    // Append the model's turn verbatim so the next iteration sees its own
    // tool_use blocks.
    messages.push({ role: 'assistant', content: resp.content as unknown as ContentBlock[] });

    const toolUses = (resp.content as unknown as ContentBlock[]).filter(
      (b) => (b as { type?: string }).type === 'tool_use',
    );

    // No tool calls → this is the final answer. Capture the text blocks.
    if (toolUses.length === 0) {
      finalText = extractText(resp);
      break;
    }

    // Execute every tool call the model issued, in order, and feed the
    // results back in a single user turn.
    const resultBlocks: ContentBlock[] = [];
    for (const block of toolUses) {
      const tu = block as { id: string; name: string; input: unknown };
      const call: EffectCall = { effect: tu.name as EffectName, args: tu.input ?? {} };
      let summary: string;
      let isError = false;
      try {
        summary = await executeEffect(call, mode.effectCtx);
      } catch (err) {
        summary = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      effectsApplied.push({ call, summary });
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: summary,
        is_error: isError,
      });
    }
    messages.push({ role: 'user', content: resultBlocks });
  }

  return {
    text: finalText,
    effectsApplied,
    usage,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractText(resp: Anthropic.Message): string {
  const out: string[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') out.push(block.text);
  }
  return out.join('').trim();
}

function resolveSkillContext(refs: string[], skills: Skill[]): string {
  if (refs.length === 0) return '';
  const byName = new Map(skills.map((s) => [s.name, s]));
  const sections: string[] = [];
  for (const ref of refs) {
    const skill = byName.get(ref);
    if (!skill) continue;
    sections.push(`## Skill: ${skill.name}\n\n${skill.body.trim()}`);
  }
  if (sections.length === 0) return '';
  return ['# Reference skills', '', ...sections].join('\n\n');
}

function formatTarget(target: ActionTarget): string {
  const labels = target.labels.length > 0 ? target.labels.join(', ') : '(none)';
  const head = [
    `${target.kind === 'pr' ? 'PR' : 'Issue'} #${target.number} — ${target.title}`,
    `State: ${target.state}`,
    `Labels: ${labels}`,
    target.htmlUrl ? `URL: ${target.htmlUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  const body = ['', '## Body', target.body || '(empty)'].join('\n');
  const comments = target.comments ? `\n\n## Comments\n${target.comments}` : '';
  return `${head}${body}${comments}`;
}
