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
    needsResponseBatchSize: z.number().default(15),
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
      'git status',
      'git diff',
      'git log',
      'git show',
    ]),
    draftPr: z.boolean().default(true),
    prLabels: z.array(z.string()).default(['cezar-autofix']),
    skillsDir: z.string().default('.cezar/skills'),
    models: z.object({
      analyzer: z.string().default('claude-sonnet-4-20250514'),
      fixer: z.string().default('claude-sonnet-4-20250514'),
      reviewer: z.string().default('claude-haiku-4-5-20251001'),
    }).default({}),
    maxTurns: z.object({
      analyzer: z.number().default(15),
      fixer: z.number().default(30),
      reviewer: z.number().default(10),
    }).default({}),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
