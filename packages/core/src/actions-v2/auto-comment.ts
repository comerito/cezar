import { withAuditFooter, type AuditFooterMeta } from '../services/audit.js';
import type { EffectCall } from './effects.js';

export interface BuildAutoCommentArgs {
  actionName: string;
  /** The model's free-form summary / final text — the "why". */
  text?: string;
  /** Effects the action applied — used for the bulleted "Applied" section. */
  effectsApplied: ReadonlyArray<{ call: EffectCall; summary: string }>;
  /** Footer metadata (model, tokens, trigger label, …). */
  meta: AuditFooterMeta;
}

/**
 * Builds the Cezar-branded auto-comment body that the action runner posts on
 * the target after a successful run. Kept side-effect-free so the unit test
 * can exercise the formatting branches without touching the runner.
 *
 *   heading
 *   <text — the why, or a fallback sentence>
 *
 *   *Applied:*
 *   - <effect.summary>
 *
 *   ---
 *   <audit footer with provenance>
 */
export function buildAutoCommentBody(args: BuildAutoCommentArgs): string {
  const heading = `**Cezar · ${args.actionName}**`;
  const text = (args.text ?? '').trim();
  const effects = args.effectsApplied;

  const why = text.length > 0
    ? text
    : effects.length > 0
      ? `Ran ${args.actionName} — applied ${effects.length} effect${effects.length === 1 ? '' : 's'}.`
      : `Ran ${args.actionName} — no changes applied.`;

  const sections: string[] = [heading, '', why];
  if (effects.length > 0) {
    sections.push('', '*Applied:*');
    for (const e of effects) sections.push(`- ${e.summary}`);
  }
  return withAuditFooter(sections.join('\n'), args.meta);
}

/**
 * The runner skips the auto-comment when the action itself already posted
 * one via the `comment` effect (or an effect that internally calls
 * `addComment`, e.g. `link-duplicate`). Avoids double-commenting.
 */
const COMMENT_POSTING_EFFECTS = new Set<string>(['comment', 'link-duplicate']);

export function actionAlreadyCommented(
  effectsApplied: ReadonlyArray<{ call: EffectCall; summary: string }>,
): boolean {
  for (const e of effectsApplied) {
    if (COMMENT_POSTING_EFFECTS.has(e.call.effect)) return true;
  }
  return false;
}
