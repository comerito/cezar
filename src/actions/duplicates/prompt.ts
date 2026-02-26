import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const DuplicateResponseSchema = z.object({
  duplicates: z.array(z.object({
    number: z.number(),
    duplicateOf: z.number(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })),
});

export function buildDuplicatePrompt(
  candidates: StoredIssue[],
  knowledgeBase: StoredIssue[],
): string {
  return `KNOWLEDGE BASE — all open issues (compact digest format):
${knowledgeBase.map(formatCompact).join('\n')}

CANDIDATES — check each of these against the knowledge base for duplicates:
${candidates.map(formatCompact).join('\n')}

An issue is a duplicate if it describes the same underlying problem or feature request,
even if the wording is completely different.

Rules:
- A candidate can only be a duplicate of a KNOWLEDGE BASE issue (not another candidate)
- The original is always the lower-numbered issue
- Only include candidates that ARE duplicates (omit non-duplicates entirely)
- Minimum confidence to include: 0.80
- If unsure, omit rather than guess

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "duplicates": [
    {
      "number": 456,
      "duplicateOf": 123,
      "confidence": 0.95,
      "reason": "One sentence explaining why these are the same issue"
    }
  ]
}`;
}

export function formatCompact(issue: StoredIssue): string {
  const d = issue.digest!;
  return `#${issue.number} [${d.category}] ${d.affectedArea} | ${d.summary} | kw: ${d.keywords.join(', ')}`;
}
