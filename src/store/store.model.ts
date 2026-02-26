import { z } from 'zod';

export const IssueAnalysisSchema = z.object({
  // Duplicates action
  duplicateOf: z.number().nullable().default(null),
  duplicateConfidence: z.number().min(0).max(1).nullable().default(null),
  duplicateReason: z.string().nullable().default(null),
  duplicatesAnalyzedAt: z.string().nullable().default(null),

  // Priority action (future — included now so store schema is stable)
  priority: z.enum(['critical', 'high', 'medium', 'low']).nullable().default(null),
  priorityReason: z.string().nullable().default(null),
  priorityAnalyzedAt: z.string().nullable().default(null),
});

export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>;

export const IssueDigestSchema = z.object({
  summary: z.string(),
  category: z.enum(['bug', 'feature', 'docs', 'chore', 'question', 'other']),
  affectedArea: z.string(),
  keywords: z.array(z.string()),
  digestedAt: z.string(),
});

export type IssueDigest = z.infer<typeof IssueDigestSchema>;

export const StoredIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.string()),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  htmlUrl: z.string(),
  contentHash: z.string(),
  digest: IssueDigestSchema.nullable().default(null),
  analysis: IssueAnalysisSchema.default({}),
});

export type StoredIssue = z.infer<typeof StoredIssueSchema>;

export const StoreMetaSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  lastSyncedAt: z.string().nullable().default(null),
  totalFetched: z.number().default(0),
  version: z.literal(1).default(1),
});

export type StoreMeta = z.infer<typeof StoreMetaSchema>;

export const StoreSchema = z.object({
  meta: StoreMetaSchema,
  issues: z.array(StoredIssueSchema),
});

export type Store = z.infer<typeof StoreSchema>;
