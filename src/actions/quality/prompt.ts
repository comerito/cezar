import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const QualityCheckResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    quality: z.enum(['spam', 'vague', 'test', 'wrong-language', 'ok']),
    reason: z.string(),
    suggestedLabel: z.string().nullable(),
  })),
});

export type QualityCheckResponse = z.infer<typeof QualityCheckResponseSchema>;

export function buildQualityCheckPrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForCheck).join('\n\n---\n\n');

  return `You are checking GitHub issues for submission quality. Identify low-quality submissions that waste maintainer time.

QUALITY CATEGORIES:
- "spam" — Promotional content, SEO links, completely unrelated to the project. suggestedLabel: "invalid"
- "vague" — No actionable information. Examples: "it doesn't work", "help me", "broken". No steps, no context, no details. suggestedLabel: "needs-info"
- "test" — Accidental/test submissions. Examples: "asdf", "test issue", "aaa", empty or near-empty body. suggestedLabel: "invalid"
- "wrong-language" — Written in a language other than English (if the repository primarily uses English). suggestedLabel: "invalid"
- "ok" — Legitimate issue with enough substance to be actionable. suggestedLabel: null

DECISION RULES:
- Be conservative — when in doubt, mark as "ok"
- A short but clear issue is NOT vague. "Button X crashes on click" is fine even without steps
- Issues with code snippets, error messages, or screenshots are rarely vague
- Feature requests can be brief — "Add dark mode" is valid even without details
- Non-English issues are only flagged if the repo clearly uses English
- Only flag as spam if content is clearly promotional or completely off-topic
- For "ok" issues, reason can be empty and suggestedLabel should be null

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 301,
      "quality": "spam",
      "reason": "Promotional content for unrelated product with SEO links",
      "suggestedLabel": "invalid"
    }
  ]
}`;
}

function formatIssueForCheck(issue: StoredIssue): string {
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  return `#${issue.number}${labels} — ${issue.title}
Author: @${issue.author}
Body:
${issue.body.slice(0, 3000)}`;
}
