import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';
import { formatCommentsForPrompt } from '../../utils/comment-formatter.js';

export const PriorityResponseSchema = z.object({
  priorities: z.array(z.object({
    number: z.number(),
    priority: z.enum(['critical', 'high', 'medium', 'low']),
    reason: z.string(),
    signals: z.array(z.string()),
  })),
});

export type PriorityResponse = z.infer<typeof PriorityResponseSchema>;

export function buildPriorityPrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForPriority).join('\n\n---\n\n');

  return `You are assigning priority levels to GitHub issues based on their impact and urgency.

PRIORITY RUBRIC:
- critical: data loss, security vulnerability, production down, affects majority of users
- high: regression, broken core functionality, affects significant user segment
- medium: non-critical bug, UX issue, affects subset of users
- low: enhancement, nice-to-have, cosmetic, edge case

Rules:
- Assign exactly one priority level per issue
- The "signals" array must cite specific evidence from the issue text — do NOT make generic claims
- Consider comment count and reactions as engagement signals (higher = likely more impactful)
- Comment content can reveal urgency, affected user count, and workarounds — use this to refine priority
- Be conservative with "critical" — reserve it for genuine emergencies
- Enhancement requests should generally be "low" unless they address a significant gap

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "priorities": [
    {
      "number": 123,
      "priority": "high",
      "reason": "Login broken on Safari iOS affects ~15% of mobile users",
      "signals": ["broken core feature", "mobile-specific regression", "12 reactions"]
    }
  ]
}`;
}

function formatIssueForPriority(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const commentSection = formatCommentsForPrompt(issue.comments);
  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Comments: ${issue.commentCount} | Reactions: ${issue.reactions}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}${commentSection ? `\n${commentSection}` : ''}`;
}
