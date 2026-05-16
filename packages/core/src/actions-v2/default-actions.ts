import type { ActionDef } from './action.js';

/**
 * Built-in default Action catalog — must match
 * `packages/gui/supabase/migrations/0014_seed_default_actions.sql`.
 *
 * The CLI consumes this catalog directly because it has no Supabase client;
 * the SaaS path reads the same specs from the `actions` table seeded by the
 * SQL migration. The two must stay in sync by hand until a future commit
 * unifies them (seed-from-TS).
 *
 * `id` and `workspaceId` are intentionally blank — the CLI never persists
 * Action rows, and the runner treats `ActionDef` as a pure spec.
 */
export const DEFAULT_ACTIONS: ActionDef[] = [
  {
    id: '',
    workspaceId: '',
    name: 'auto-triage',
    kind: 'built-in',
    description:
      'First-pass triage applied once per new issue or PR. Adds type labels and (for clear critical defects) a priority. Defers commenting, closing, and assigning to specialised actions.',
    systemPrompt:
      'You are running the first triage pass on a freshly-opened item. Read the playbook in your reference skills and apply ONLY the effects it authorises. Be conservative — when a signal is weak, do less. Call label.add for type labels and set-priority for clear critical defects. Do not comment, close, link as duplicate, or assign in this pass.',
    skillRefs: ['auto-triage-playbook', 'bug-classification'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-reopened', 'manual'],
    effects: null,
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'bug-detector',
    kind: 'built-in',
    description: 'Classify an issue as bug / feature / question / other using a confidence-calibrated rubric.',
    systemPrompt:
      'Classify the issue using the bug-classification playbook in your reference skills. Output a structured classification: a category, a confidence between 0 and 1, and one short sentence citing the signal you relied on. When confident this is a bug, add the bug label.',
    skillRefs: ['bug-classification'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-edited', 'manual'],
    effects: ['label.add'],
    outputSchema: {
      type: 'object',
      required: ['category', 'confidence', 'reason'],
      properties: {
        category: { type: 'string', enum: ['bug', 'feature', 'question', 'other'] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'priority',
    kind: 'built-in',
    description: 'Assign an impact-and-urgency priority level (critical / high / medium / low) with cited signals.',
    systemPrompt:
      'Pick exactly one priority level per the priority-rubric playbook in your reference skills. Cite specific evidence from the issue body — not generic claims. Apply the priority via set-priority.',
    skillRefs: ['priority-rubric'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: ['set-priority'],
    outputSchema: {
      type: 'object',
      required: ['priority', 'reason', 'signals'],
      properties: {
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        reason: { type: 'string' },
        signals: { type: 'array', items: { type: 'string' } },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'duplicates',
    kind: 'built-in',
    description: 'Detect duplicate issues against an open-issue knowledge base; minimum confidence 0.80.',
    systemPrompt:
      'Apply the dedupe-heuristics playbook in your reference skills. Only flag matches at confidence ≥ 0.80. Use the link-duplicate effect to mark the duplicate; do NOT call close (a human reviewer decides).',
    skillRefs: ['dedupe-heuristics'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: null,
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'auto-label',
    kind: 'built-in',
    description: 'Apply repo-defined labels based on content. Never invents new labels.',
    systemPrompt:
      "Apply the auto-labeling-rubric playbook in your reference skills. ONLY use labels from the repository's existing label set passed in the context. Add labels via label.add; remove obviously wrong labels via label.remove.",
    skillRefs: ['auto-labeling-rubric'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-edited', 'manual'],
    effects: null,
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'missing-info',
    kind: 'built-in',
    description: 'Detect bug reports missing critical info; post a tailored ask if so.',
    systemPrompt:
      'Apply the missing-info-checklist playbook in your reference skills. Check comments first — if the missing info was already provided, set hasMissingInfo to false. For incomplete reports, post a polite tailored comment (3–5 bullets max) asking for exactly what is needed.',
    skillRefs: ['missing-info-checklist'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: ['comment', 'label.add'],
    outputSchema: {
      type: 'object',
      required: ['hasMissingInfo'],
      properties: {
        hasMissingInfo: { type: 'boolean' },
        missingFields: { type: 'array', items: { type: 'string' } },
        suggestedComment: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'security',
    kind: 'built-in',
    description: 'Flag issues with security implications, even when not explicitly labelled.',
    systemPrompt:
      'Apply the security-signals playbook in your reference skills. Flag only at confidence ≥ 0.70. False positives are preferable to missing a vulnerability. Add a security label via label.add and consider posting a maintainer-only comment summarising the finding.',
    skillRefs: ['security-signals'],
    target: 'issue',
    triggers: ['on-issue-opened', 'on-issue-edited', 'manual'],
    effects: ['label.add', 'comment'],
    outputSchema: {
      type: 'object',
      required: ['isSecurityRelated', 'confidence'],
      properties: {
        isSecurityRelated: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        category: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        explanation: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'quality',
    kind: 'built-in',
    description: 'Identify low-quality submissions (spam, vague, test, wrong-language).',
    systemPrompt:
      'Apply the quality-rubric playbook in your reference skills. Be conservative — when in doubt mark "ok". Apply the suggested label (if any) via label.add.',
    skillRefs: ['quality-rubric'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: ['label.add'],
    outputSchema: {
      type: 'object',
      required: ['quality'],
      properties: {
        quality: { type: 'string', enum: ['ok', 'spam', 'vague', 'test', 'wrong-language'] },
        reason: { type: 'string' },
        suggestedLabel: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'good-first-issue',
    kind: 'built-in',
    description: 'Surface issues suitable for newcomers; add the good-first-issue label.',
    systemPrompt:
      'Apply the good-first-issue-signals playbook in your reference skills. Reject issues that need deep architectural understanding or substantial refactoring. When suitable, add the good-first-issue label via label.add.',
    skillRefs: ['good-first-issue-signals'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: ['label.add'],
    outputSchema: {
      type: 'object',
      required: ['isGoodFirstIssue'],
      properties: {
        isGoodFirstIssue: { type: 'boolean' },
        reason: { type: 'string' },
        codeHint: { type: 'string' },
        estimatedComplexity: { type: 'string', enum: ['trivial', 'small', 'medium'] },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'claim-detector',
    kind: 'built-in',
    description: 'Find issues where someone claimed to take it but went silent (>14 days).',
    systemPrompt:
      'Apply the claim-signals playbook in your reference skills. Only flag claims older than 14 days with no follow-through and no PR reference. Post the polite nudge via comment.',
    skillRefs: ['claim-signals'],
    target: 'issue',
    triggers: ['on-cron', 'manual'],
    effects: ['comment'],
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'contributor-welcome',
    kind: 'built-in',
    description: 'Personalised welcome comment for first-time contributors.',
    systemPrompt:
      'Apply the contributor-welcome playbook in your reference skills. Reference a specific detail from the issue — no generic platitudes. 3–5 sentences max. Post via comment.',
    skillRefs: ['contributor-welcome'],
    target: 'issue',
    triggers: ['on-issue-opened'],
    effects: ['comment'],
    outputSchema: {
      type: 'object',
      required: ['welcomeMessage'],
      properties: {
        welcomeMessage: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'recurring-questions',
    kind: 'built-in',
    description: 'Detect open questions already answered in closed issues; suggest a redirect.',
    systemPrompt:
      'Apply the recurring-question-patterns playbook in your reference skills. Reference closed issues by number — never invent answers. Post the suggested redirect via comment.',
    skillRefs: ['recurring-question-patterns'],
    target: 'issue',
    triggers: ['on-cron', 'manual'],
    effects: ['comment'],
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'categorize',
    kind: 'built-in',
    description: 'Categorise issues as framework / domain / integration based on the area touched.',
    systemPrompt:
      'Apply the categorization-rubric playbook in your reference skills. One category per issue. Add an area label via label.add when appropriate.',
    skillRefs: ['categorization-rubric'],
    target: 'issue',
    triggers: ['on-issue-opened', 'manual'],
    effects: ['label.add'],
    outputSchema: {
      type: 'object',
      required: ['category', 'reason'],
      properties: {
        category: { type: 'string', enum: ['framework', 'domain', 'integration'] },
        reason: { type: 'string' },
      },
    },
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'done-detector',
    kind: 'built-in',
    description: 'Find open issues silently resolved by merged PRs; suggest closing.',
    systemPrompt:
      'Apply the done-signals playbook in your reference skills. Mark isDone only at confidence ≥ 0.70. Post a polite closing comment via comment and close via close when confident.',
    skillRefs: ['done-signals'],
    target: 'issue',
    triggers: ['on-cron', 'manual'],
    effects: ['comment', 'close'],
    outputSchema: null,
    enabled: true,
  },
  {
    id: '',
    workspaceId: '',
    name: 'stale',
    kind: 'built-in',
    description: 'Triage stale issues — close / label / keep-open per the stale-criteria rubric.',
    systemPrompt:
      'Apply the stale-criteria playbook in your reference skills. Prefer label-stale over closing when unsure. For close-resolved / close-wontfix, post the draft comment and call close. For label-stale, post the comment and add a stale label via label.add.',
    skillRefs: ['stale-criteria'],
    target: 'issue',
    triggers: ['on-cron', 'manual'],
    effects: ['comment', 'close', 'label.add'],
    outputSchema: null,
    enabled: true,
  },
];
