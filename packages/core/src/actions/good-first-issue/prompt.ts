import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const GoodFirstIssueResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    isGoodFirstIssue: z.boolean(),
    reason: z.string(),
    codeHint: z.string(),
    estimatedComplexity: z.enum(['trivial', 'small', 'medium']),
  })),
});

export type GoodFirstIssueResponse = z.infer<typeof GoodFirstIssueResponseSchema>;

export function buildGoodFirstIssuePrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForAnalysis).join('\n\n---\n\n');

  return `You are evaluating GitHub issues to determine which ones are suitable for new contributors ("good first issue").

CRITERIA for a good first issue:
- Self-contained scope — can be completed without understanding the full architecture
- Clear acceptance criteria — the expected outcome is unambiguous
- No architectural decisions needed — implementation approach is straightforward
- Reasonable effort — less than 1 day for a newcomer with basic experience
- Well-documented area — the affected code area is approachable

REJECT if:
- Issue requires deep understanding of multiple interconnected systems
- Issue involves complex concurrency, performance optimization, or security-sensitive code
- Issue is vague or under-specified
- Issue requires significant refactoring or breaking changes

For suitable issues:
- Provide a concise reason explaining why it's good for newcomers
- Provide a code hint suggesting where to start (based on the affected area)
- Estimate complexity: trivial (< 1 hour), small (a few hours), medium (half a day)

For unsuitable issues: set isGoodFirstIssue to false (reason and codeHint can be empty).

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 156,
      "isGoodFirstIssue": true,
      "reason": "Self-contained validation logic with clear acceptance criteria",
      "codeHint": "Look at src/forms/ — validation utils already exist for other fields",
      "estimatedComplexity": "small"
    }
  ]
}`;
}

function formatIssueForAnalysis(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}`;
}
