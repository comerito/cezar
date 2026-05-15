import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const LabelResponseSchema = z.object({
  labels: z.array(z.object({
    number: z.number(),
    suggested: z.array(z.string()),
    reason: z.string(),
  })),
});

export type LabelResponse = z.infer<typeof LabelResponseSchema>;

export function buildLabelPrompt(candidates: StoredIssue[], repoLabels: string[]): string {
  const labelList = repoLabels.map(l => `  - ${l}`).join('\n');
  const issueList = candidates.map(formatIssueForLabeling).join('\n\n---\n\n');

  return `You are labeling GitHub issues for a repository. You must ONLY use labels from the repository's existing label set below — do NOT invent new labels.

AVAILABLE LABELS:
${labelList}

For each issue, suggest which labels should be added based on the issue content. Consider:
- Type labels: bug, enhancement, documentation, question, etc.
- Area labels: inferred from the affected area (e.g. "area: auth", "area: api")
- Priority labels: only assign critical/high priority when the issue describes data loss, security vulnerabilities, crashes, or production outages
- If the issue already has the correct labels, return an empty "suggested" array
- Only suggest labels that are NOT already on the issue
- Each suggestion must use an exact label name from the AVAILABLE LABELS list

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "labels": [
    {
      "number": 123,
      "suggested": ["bug", "area: auth"],
      "reason": "Bug report about authentication failure in the login module"
    }
  ]
}`;
}

function formatIssueForLabeling(issue: StoredIssue): string {
  const d = issue.digest!;
  const currentLabels = issue.labels.length > 0 ? issue.labels.join(', ') : '(none)';
  return `#${issue.number} — ${issue.title}
Current labels: ${currentLabels}
Category: ${d.category} | Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}`;
}
