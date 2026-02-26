import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const RecurringQuestionResponseSchema = z.object({
  questions: z.array(z.object({
    number: z.number(),
    isRecurring: z.boolean(),
    similarClosedIssues: z.array(z.number()),
    suggestedResponse: z.string(),
    confidence: z.number().min(0).max(1),
  })),
});

export type RecurringQuestionResponse = z.infer<typeof RecurringQuestionResponseSchema>;

export function buildRecurringQuestionPrompt(candidates: StoredIssue[], closedIssues: StoredIssue[]): string {
  const candidateList = candidates.map(formatCandidate).join('\n\n---\n\n');
  const knowledgeBase = closedIssues.map(formatClosedIssue).join('\n');

  return `You are analyzing open GitHub issues categorized as "question" to determine if they have already been answered in previously closed issues.

KNOWLEDGE BASE — Closed issues with answers:
${knowledgeBase}

For each open question below, determine if a substantially similar question was already answered in one of the closed issues above.

Rules:
- Only mark as recurring if the closed issue genuinely answers the open question
- The suggested response MUST reference the closed issue number(s) — do NOT invent answers
- Summarize what the closed issue covers so the user gets immediate value
- If no match exists, set isRecurring to false with an empty similarClosedIssues array
- Confidence should reflect how well the closed issue(s) answer the open question

OPEN QUESTIONS:
${candidateList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "questions": [
    {
      "number": 123,
      "isRecurring": true,
      "similarClosedIssues": [45, 89],
      "suggestedResponse": "This has been answered before! Check out:\\n\\n- #45 covers timeout configuration in detail\\n- #89 has additional context on request timeouts\\n\\nClosing as answered — feel free to reopen if your question is different.",
      "confidence": 0.85
    }
  ]
}`;
}

function formatCandidate(issue: StoredIssue): string {
  const d = issue.digest!;
  return `#${issue.number} — ${issue.title}
Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}`;
}

function formatClosedIssue(issue: StoredIssue): string {
  const d = issue.digest!;
  return `  #${issue.number} — ${issue.title} | Area: ${d.affectedArea} | Summary: ${d.summary}`;
}
