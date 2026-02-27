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
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
