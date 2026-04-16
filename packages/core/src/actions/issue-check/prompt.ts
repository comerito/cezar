import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';
import { formatCommentsForPrompt } from '../../utils/comment-formatter.js';

export const IssueCheckResponseSchema = z.object({
  matches: z.array(z.object({
    number: z.number(),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })),
});

export type IssueCheckResponse = z.infer<typeof IssueCheckResponseSchema>;

export function buildIssueCheckPrompt(description: string, openIssues: StoredIssue[]): string {
  const issueList = openIssues.map(formatCompact).join('\n');

  return `KNOWLEDGE BASE — all open issues (compact digest format):
${issueList}

USER DESCRIPTION — a new issue the user wants to report:
${description}

Does this description match any existing open issue? An issue matches if it describes
the same underlying problem, feature request, or question — even if the wording is different.

Rules:
- Only include matches with confidence >= 0.60
- Order results by confidence descending
- If nothing matches, return an empty array
- If unsure, omit rather than guess
- Consider keywords, affected area, and category when matching

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "matches": [
    {
      "number": 123,
      "confidence": 0.85,
      "reason": "One sentence explaining why this is a match"
    }
  ]
}`;
}

function formatCompact(issue: StoredIssue): string {
  const d = issue.digest!;
  const commentSummary = formatCommentsForPrompt(issue.comments, {
    maxComments: 3,
    maxCharsPerComment: 200,
    maxTotalChars: 800,
  });
  const base = `#${issue.number} [${d.category}] ${d.affectedArea} | ${d.summary} | kw: ${d.keywords.join(', ')}`;
  return commentSummary ? `${base}\n${commentSummary}` : base;
}
