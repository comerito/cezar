import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const BugDetectorResponseSchema = z.object({
  classifications: z.array(z.object({
    number: z.number(),
    issueType: z.enum(['bug', 'feature', 'question', 'other']),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
  })),
});

export type BugDetectorResponse = z.infer<typeof BugDetectorResponseSchema>;

export function buildBugDetectorPrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForBugDetection).join('\n\n---\n\n');

  return `You are classifying GitHub issues to identify which ones are bug reports.

CATEGORIES:
  - bug — Something is broken, produces wrong output, crashes, or behaves differently from what is documented/expected. Bug reports usually include reproduction steps, actual vs expected behavior, error messages, or stack traces.
  - feature — A request for new functionality or an enhancement to existing functionality that is not currently broken.
  - question — The reporter is asking how to use something, seeking clarification, or requesting support. No code defect is implied.
  - other — Docs, chores, discussions, tracking issues, or anything that does not fit the three categories above.

RULES:
- Each issue gets exactly one category and a confidence between 0 and 1.
- Use confidence >= 0.8 only when the issue text clearly matches the category (reproduction steps for bugs, explicit feature request wording, explicit question, etc).
- Use 0.5 - 0.8 when the category is likely but the text is ambiguous.
- Use < 0.5 when you're unsure — still pick the best-fit category but signal low confidence.
- Prefer "other" over guessing when the issue is clearly not a bug/feature/question (e.g. a tracking meta-issue, a release checklist, a duplicate/stale marker).
- reason: one short sentence citing the signal you relied on (e.g. "contains stack trace and steps to reproduce", "explicit 'feature request' label and asks for new API").

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "classifications": [
    {
      "number": 123,
      "issueType": "bug",
      "confidence": 0.92,
      "reason": "Includes stack trace and deterministic repro; title says 'crashes when'"
    }
  ]
}`;
}

function formatIssueForBugDetection(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : '(none)';
  return `#${issue.number} — ${issue.title}
Labels: ${labels}
Digest: category=${d.category} | area=${d.affectedArea} | keywords=${d.keywords.join(', ')}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2500)}`;
}
