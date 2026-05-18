import { z } from 'zod';
import { resolve } from 'node:path';

export const ConfigSchema = z.object({
  github: z.object({
    owner: z.string().default(''),
    repo: z.string().default(''),
    token: z.string().default(''),
  }).default({}),
  llm: z.object({
    model: z.string().default('claude-sonnet-4-20250514'),
    maxTokens: z.number().default(4096),
    apiKey: z.string().default(''),
  }).default({}),
  store: z.object({
    path: z.string().default('.issue-store').refine(
      (p) => resolve(p).startsWith(process.cwd()),
      'Store path must be within the project directory',
    ),
  }).default({}),
  sync: z.object({
    digestBatchSize: z.number().default(20),
    duplicateBatchSize: z.number().default(30),
    minDuplicateConfidence: z.number().default(0.80),
    includeClosed: z.boolean().default(false),
    labelBatchSize: z.number().default(20),
    missingInfoBatchSize: z.number().default(15),
    recurringBatchSize: z.number().default(15),
    priorityBatchSize: z.number().default(20),
    securityBatchSize: z.number().default(20),
    staleDaysThreshold: z.number().default(90),
    staleCloseDays: z.number().default(14),
    doneDetectorBatchSize: z.number().default(10),
    categorizeBatchSize: z.number().default(20),
    bugDetectorBatchSize: z.number().default(15),
  }).default({}),
  autofix: z.object({
    enabled: z.boolean().default(false),
    repoRoot: z.string().default(''),
    remote: z.string().default('origin'),
    baseBranch: z.string().default('main'),
    fetchBeforeAttempt: z.boolean().default(true),
    branchPrefix: z.string().default('autofix/cezar-issue-'),
    maxAttemptsPerIssue: z.number().default(2),
    maxConcurrent: z.number().default(1),
    tokenBudgetPerAttempt: z.number().default(250_000),
    ciFixMax: z.number().default(2),
    ciFixTokenBudget: z.number().default(120_000),
    requireReviewPass: z.boolean().default(true),
    minBugConfidence: z.number().min(0).max(1).default(0.7),
    minAnalyzerConfidence: z.number().min(0).max(1).default(0.5),
    retryOnReviewFailure: z.boolean().default(true),
    allowedTools: z.array(z.string()).default(['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']),
    bashAllowlist: z.array(z.string()).default([
      'npm test',
      'npm run typecheck',
      'npm run lint',
      'npm run build',
      'yarn',
      'yarn test',
      'yarn typecheck',
      'yarn lint',
      'yarn build',
      'git status',
      'git diff',
      'git log',
      'git show',
    ]),
    setupCommands: z.array(z.string()).default([]),
    draftPr: z.boolean().default(true),
    prLabels: z.array(z.string()).default(['cezar-autofix']),
    skillsDir: z.string().default('.ai/skills'),
    models: z.object({
      // Defaults bumped 2026-05-17: was claude-sonnet-4-20250514 (~6 months
      // old, slower per-turn). Sonnet 4.6 reaches the same conclusion in
      // fewer turns; Haiku 4.5 stays as the cheap reviewer.
      analyzer: z.string().default('claude-sonnet-4-6'),
      fixer: z.string().default('claude-sonnet-4-6'),
      reviewer: z.string().default('claude-haiku-4-5-20251001'),
    }).default({}),
    maxTurns: z.object({
      analyzer: z.number().default(15),
      fixer: z.number().default(30),
      reviewer: z.number().default(10),
    }).default({}),
    // Persistent-session refactor controls.
    // See docs/REFACTOR-PLAN-persistent-autofix-session.md.
    // Both default to today's behavior — flipping a flag is the only way
    // to opt a workspace into the new path.
    runner: z.object({
      // 'print'       — spawn `claude -p <userPrompt>` per step (today).
      // 'stream-json' — spawn once without -p, write user message to
      //                 stdin, read until type='result'. Phase A.
      transport: z.enum(['print', 'stream-json']).default('print'),
      // 'staged'  — four separate `claude` sessions, one per phase (today).
      // 'unified' — one long-lived session with phase markers. Phase B.
      //             Requires `transport: 'stream-json'` and forces backend='claude-cli'.
      mode: z.enum(['staged', 'unified']).default('staged'),
    }).default({}),
  }).default({}),
  // Optional GUI-equivalent binding block the CLI can supply from
  // `.issuemanagerrc.json`. Empty ⇒ built-in defaults ⇒ behavior identical to
  // today (see docs/REFACTOR-PLAN-agent-cockpit.md §3.5). The full workflow
  // engine lands in Phase 2; today only the autofix orchestrator reads these.
  workflow: z.object({
    // Phase 3a: when true, `AutofixOrchestrator` delegates to the declarative
    // workflow engine (`runWorkflow`) instead of its hand-rolled path. Defaults
    // off ⇒ today's behavior is byte-identical.
    useEngine: z.boolean().default(false),
    bindings: z.array(z.object({
      stepId: z.string(),
      skillName: z.string().nullable().default(null),
      backend: z.enum(['anthropic-api', 'claude-cli', 'codex-cli']).nullable().default(null),
      model: z.string().nullable().default(null),
      extraTools: z.array(z.string()).default([]),
    })).default([]),
    settings: z.object({
      autoTriageEnabled: z.boolean().default(true),
      autofixEnabled: z.boolean().default(false),
      separateCommentPerStep: z.boolean().default(false),
    }).default({}),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
