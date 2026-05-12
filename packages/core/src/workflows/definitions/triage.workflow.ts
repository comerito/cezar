import { z } from 'zod';
import { BugDetectorResponseSchema } from '../../actions/bug-detector/prompt.js';
import { PriorityResponseSchema } from '../../actions/priority/prompt.js';
import { agentStep, type Workflow, type WorkflowStep, type CommentSection } from '../workflow.js';

/**
 * The `triage` workflow — SKETCH ONLY for Phase 2 (docs §3.2). Cheap and
 * *repo-less*: its `agent` steps wrap the EXISTING triage action prompts so a
 * future webhook trigger (Phase 5) can classify an incoming issue and decide
 * what should happen with it (`autofix` / `needs-info` / `label-only` / `ignore`).
 *
 * This is intentionally minimal: it compiles, has the right shape, and is not
 * wired into any caller yet. TODO(phase-5): trigger this from the GitHub App
 * webhook receiver; if `route === 'autofix' && autofixEnabled` enqueue the
 * autofix workflow, else post the triage summary + apply labels.
 *
 * The other ~10 triage actions (`categorize`, `security`, `quality`,
 * `good-first-issue`, `missing-info`, `needs-response`, `claim-detector`,
 * `contributor-welcome`, `recurring-questions`, `release-notes`,
 * `milestone-planner`, and the mutating `auto-label`/`stale`/`done-detector`/
 * `duplicates` effects) are *optional* triage steps / post-route effects, to be
 * wired in per workspace in Phase 5/6 — not implemented here.
 */

// ─── NEW: route-decision step ───────────────────────────────────────────────

export const RouteDecisionSchema = z.object({
  route: z.enum(['autofix', 'needs-info', 'label-only', 'ignore']),
  reason: z.string(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

const ROUTE_DECISION_SYSTEM_PROMPT = `You are the ROUTE-DECISION agent. Given the prior triage signals for a GitHub issue (is-it-a-bug classification, priority, dedupe check), decide what should happen with the issue:

- "autofix" — it's a real, well-specified bug that an automated agent can plausibly fix.
- "needs-info" — it's a plausible bug but the report is missing the information needed to act.
- "label-only" — it should just be labelled/categorized (feature request, question, low-priority polish) — no fix, no follow-up needed.
- "ignore" — spam, duplicate, off-topic, or already resolved.

Output ONLY a single JSON object (no markdown fences, no prose):
{ "route": "autofix" | "needs-info" | "label-only" | "ignore", "reason": "one short sentence citing the prior signals" }`;

// ─── Blackboard ─────────────────────────────────────────────────────────────

export interface TriageBlackboard {
  isBug?: { issueType: 'bug' | 'feature' | 'question' | 'other'; confidence: number; reason: string };
  priority?: { priority: 'critical' | 'high' | 'medium' | 'low'; reason: string };
  /** Thin dedupe signal (TODO: a real reuse of the duplicates prompt). */
  duplicateOf?: number | null;
  route?: RouteDecision;
}

// ─── Steps ──────────────────────────────────────────────────────────────────

const isABugStep: WorkflowStep<TriageBlackboard> = agentStep<TriageBlackboard, z.infer<typeof BugDetectorResponseSchema>>({
  id: 'is-a-bug',
  kind: 'agent',
  builtinSkillId: 'bug-detector',
  // Reuses actions/bug-detector/prompt.ts. The triage workflow runs one issue
  // at a time, so the user prompt asks about a single issue and the schema
  // expects a `classifications` array of length 1.
  builtinSystemPrompt: 'You are classifying a GitHub issue as bug / feature / question / other. Return the JSON described below.',
  builtinModel: 'claude-haiku-4-5-20251001',
  builtinTools: [],
  maxTurns: 1,
  responseSchema: BugDetectorResponseSchema,
  cwdRequired: false,
  buildUserPrompt: (ctx) =>
    `ISSUE #${ctx.issue.number}: ${ctx.issue.title}\n\n${ctx.issue.body.slice(0, 4000)}\n\n` +
    `Respond ONLY with JSON: {"classifications":[{"number":${ctx.issue.number},"issueType":"bug|feature|question|other","confidence":0..1,"reason":"..."}]}`,
  onResult: (parsed, ctx) => {
    const c = parsed.classifications.find((x) => x.number === ctx.issue.number) ?? parsed.classifications[0];
    if (!c) return { kind: 'fail', reason: 'bug-detector returned no classification' };
    return { kind: 'continue', blackboardPatch: { isBug: { issueType: c.issueType, confidence: c.confidence, reason: c.reason } } };
  },
  commentSection: (parsed, ctx): CommentSection => {
    const c = parsed.classifications.find((x) => x.number === ctx.issue.number) ?? parsed.classifications[0];
    if (!c) return null;
    return { heading: '🏷 Classification', body: `\`${c.issueType}\` (confidence ${c.confidence.toFixed(2)}) — ${c.reason}` };
  },
});

const priorityStep: WorkflowStep<TriageBlackboard> = agentStep<TriageBlackboard, z.infer<typeof PriorityResponseSchema>>({
  id: 'priority',
  kind: 'agent',
  builtinSkillId: 'priority',
  builtinSystemPrompt: 'You are assigning a priority level to a GitHub issue. Return the JSON described below.',
  builtinModel: 'claude-haiku-4-5-20251001',
  builtinTools: [],
  maxTurns: 1,
  responseSchema: PriorityResponseSchema,
  cwdRequired: false,
  buildUserPrompt: (ctx) =>
    `ISSUE #${ctx.issue.number}: ${ctx.issue.title}\n\n${ctx.issue.body.slice(0, 4000)}\n\n` +
    `Respond ONLY with JSON: {"priorities":[{"number":${ctx.issue.number},"priority":"critical|high|medium|low","reason":"...","signals":["..."]}]}`,
  onResult: (parsed, ctx) => {
    const p = parsed.priorities.find((x) => x.number === ctx.issue.number) ?? parsed.priorities[0];
    if (!p) return { kind: 'continue' };
    return { kind: 'continue', blackboardPatch: { priority: { priority: p.priority, reason: p.reason } } };
  },
  commentSection: (parsed, ctx): CommentSection => {
    const p = parsed.priorities.find((x) => x.number === ctx.issue.number) ?? parsed.priorities[0];
    if (!p) return null;
    return { heading: '📊 Priority', body: `\`${p.priority}\` — ${p.reason}` };
  },
});

// dedupe-check: a thin placeholder for now. TODO(phase-5): a real reuse of the
// duplicates prompt (it needs the whole open-issue knowledge base, which a
// repo-less single-issue step doesn't have to hand — wire it when the triage
// workflow can pull the store's open issues as context).
const dedupeCheckStep: WorkflowStep<TriageBlackboard> = {
  id: 'dedupe-check',
  kind: 'effect',
  builtinSkillId: 'duplicates',
  run: async () => ({ kind: 'continue', blackboardPatch: { duplicateOf: null } }),
  commentSection: (): CommentSection => null,
};

const routeDecisionStep: WorkflowStep<TriageBlackboard> = agentStep<TriageBlackboard, RouteDecision>({
  id: 'route-decision',
  kind: 'agent',
  builtinSkillId: 'route-decision',
  builtinSystemPrompt: ROUTE_DECISION_SYSTEM_PROMPT,
  builtinModel: 'claude-haiku-4-5-20251001',
  builtinTools: [],
  maxTurns: 1,
  responseSchema: RouteDecisionSchema,
  cwdRequired: false,
  buildUserPrompt: (ctx) => {
    const bb = ctx.blackboard;
    return [
      `ISSUE #${ctx.issue.number}: ${ctx.issue.title}`,
      '',
      `Classification: ${bb.isBug ? `${bb.isBug.issueType} (confidence ${bb.isBug.confidence.toFixed(2)}) — ${bb.isBug.reason}` : '(unknown)'}`,
      `Priority: ${bb.priority ? `${bb.priority.priority} — ${bb.priority.reason}` : '(unknown)'}`,
      `Duplicate of: ${bb.duplicateOf ?? '(none detected)'}`,
      '',
      'Decide the route and produce the JSON object.',
    ].join('\n');
  },
  onResult: (parsed) => ({ kind: 'continue', blackboardPatch: { route: parsed } }),
  commentSection: (parsed): CommentSection => ({ heading: '🧭 Triage route', body: `\`${parsed.route}\` — ${parsed.reason}` }),
});

// ─── Workflow ───────────────────────────────────────────────────────────────

export const triageWorkflow: Workflow<TriageBlackboard> = {
  id: 'triage',
  title: 'Triage',
  commentTargetOrder: ['issue'],
  initialBlackboard: () => ({}),
  steps: [isABugStep, priorityStep, dedupeCheckStep, routeDecisionStep],
};
