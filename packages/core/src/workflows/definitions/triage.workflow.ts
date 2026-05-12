import { z } from 'zod';
import { BugDetectorResponseSchema } from '../../actions/bug-detector/prompt.js';
import { PriorityResponseSchema } from '../../actions/priority/prompt.js';
import { agentStep, type Workflow, type WorkflowStep, type WorkflowStepContext, type CommentSection } from '../workflow.js';

/**
 * The `triage` workflow (docs §3.2, Phase 5). Cheap and *repo-less*: its `agent`
 * steps wrap the EXISTING triage action prompts so the GitHub App webhook
 * (`/api/github/webhook`) can classify an incoming issue and decide what should
 * happen with it (`autofix` / `needs-info` / `label-only` / `ignore`):
 *
 *   is-a-bug → priority → route-decision → apply-labels → comment-summary
 *
 * The blackboard ends up carrying `{ isBug, priority, route, … }`; the SaaS-side
 * executor lifts `route` + the bug `issueType`/`confidence` + `priority` into the
 * `workflow_runs.outcome` JSON, and `maybeEnqueueAutofixFromTriage` reads that to
 * decide whether to queue an autofix job (only when `route === 'autofix'`,
 * `autofix_enabled`, and `bugConfidence ≥ minBugConfidence`).
 *
 * TODO(phase-5): the dedupe step is still a thin placeholder — a real reuse of
 * the `duplicates` prompt needs the whole open-issue knowledge base as context.
 * The ~10 other triage actions (`categorize`, `security`, `quality`,
 * `good-first-issue`, `missing-info`, `needs-response`, `claim-detector`,
 * `contributor-welcome`, `recurring-questions`, `release-notes`,
 * `milestone-planner`, the mutating `stale`/`done-detector`/`duplicates` effects)
 * remain optional per-workspace triage steps, not wired here.
 */

// ─── route-decision ─────────────────────────────────────────────────────────

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

export type TriageIssueType = 'bug' | 'feature' | 'question' | 'other';
export type TriagePriority = 'critical' | 'high' | 'medium' | 'low';

export interface TriageBlackboard {
  isBug?: { issueType: TriageIssueType; confidence: number; reason: string };
  priority?: { priority: TriagePriority; reason: string };
  /** Thin dedupe signal (TODO(phase-5): a real reuse of the duplicates prompt). */
  duplicateOf?: number | null;
  route?: RouteDecision;
}

/**
 * The compact summary the SaaS executor records as `workflow_runs.outcome` for a
 * triage run — `maybeEnqueueAutofixFromTriage` reads `route` / `issueType` /
 * `bugConfidence`. Build it from a finished run's blackboard via
 * {@link triageOutcomeFromBlackboard}.
 */
export interface TriageOutcome {
  route: RouteDecision['route'] | null;
  routeReason: string | null;
  issueType: TriageIssueType | null;
  bugConfidence: number | null;
  priority: TriagePriority | null;
  duplicateOf: number | null;
}

export function triageOutcomeFromBlackboard(bb: TriageBlackboard): TriageOutcome {
  return {
    route: bb.route?.route ?? null,
    routeReason: bb.route?.reason ?? null,
    issueType: bb.isBug?.issueType ?? null,
    bugConfidence: bb.isBug?.confidence ?? null,
    priority: bb.priority?.priority ?? null,
    duplicateOf: bb.duplicateOf ?? null,
  };
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

const KNOWN_TYPE_LABELS: Record<TriageIssueType, string | null> = {
  bug: 'bug',
  feature: 'enhancement',
  question: 'question',
  other: null,
};

/**
 * apply-labels — derives a couple of labels from the triage signals and adds
 * them (additively; we don't `setLabels` so we never strip existing labels).
 * No-ops for `route === 'ignore'`. TODO(phase-5): make the label set / whether
 * to apply at all workspace-configurable; for now it's a fixed conservative map.
 */
const applyLabelsStep: WorkflowStep<TriageBlackboard> = {
  id: 'apply-labels',
  kind: 'effect',
  builtinSkillId: 'auto-label',
  run: async (ctx: WorkflowStepContext<TriageBlackboard>, deps) => {
    const bb = ctx.blackboard;
    if (bb.route?.route === 'ignore') return { kind: 'continue' };
    const labels: string[] = [];
    const typeLabel = bb.isBug ? KNOWN_TYPE_LABELS[bb.isBug.issueType] : null;
    if (typeLabel) labels.push(typeLabel);
    if (bb.priority) labels.push(`priority:${bb.priority.priority}`);
    for (const label of labels) {
      try {
        await deps.github.addLabel(ctx.issue.number, label);
      } catch (err) {
        ctx.log(`apply-labels: failed to add '${label}': ${(err as Error).message}`);
      }
    }
    return { kind: 'continue' };
  },
  commentSection: (): CommentSection => null,
};

/**
 * comment-summary — posts (well, the engine's living comment already streams the
 * per-step sections; this adds the final "what happens next" line). Implemented
 * as the closing section rather than a separate one-off comment so there's still
 * exactly one living comment per run (docs §3.6).
 */
const commentSummaryStep: WorkflowStep<TriageBlackboard> = {
  id: 'comment-summary',
  kind: 'effect',
  builtinSkillId: 'route-decision',
  run: async () => ({ kind: 'continue' }),
  commentSection: (ctx: WorkflowStepContext<TriageBlackboard>): CommentSection => {
    const bb = ctx.blackboard;
    const route = bb.route?.route;
    const autofixEnabled = ctx.config.autofix?.enabled === true;
    let nextStep: string;
    switch (route) {
      case 'autofix':
        nextStep = autofixEnabled
          ? '🤖 Cezar will queue an automated fix and open a **draft** PR (if the bug confidence clears the threshold).'
          : '🤖 This looks auto-fixable, but automatic fixes are disabled for this workspace — enable them in Settings → Workflows to let Cezar open a draft PR.';
        break;
      case 'needs-info':
        nextStep = 'ℹ️ This report seems to be missing information needed to act on it. A maintainer should ask for repro steps / environment details.';
        break;
      case 'label-only':
        nextStep = '🏷 Labelled. No automated follow-up needed.';
        break;
      case 'ignore':
        nextStep = '🚫 Nothing to do here (spam / duplicate / off-topic / already resolved).';
        break;
      default:
        nextStep = 'Triage complete.';
    }
    return { heading: '➡️ Next', body: nextStep };
  },
};

// ─── Workflow ───────────────────────────────────────────────────────────────

export const triageWorkflow: Workflow<TriageBlackboard> = {
  id: 'triage',
  title: 'Triage',
  commentTargetOrder: ['issue'],
  initialBlackboard: () => ({}),
  steps: [isABugStep, priorityStep, dedupeCheckStep, routeDecisionStep, applyLabelsStep, commentSummaryStep],
};
