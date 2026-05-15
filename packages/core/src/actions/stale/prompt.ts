import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';
import { formatCommentsForPrompt } from '../../utils/comment-formatter.js';

export const StaleAnalysisResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    action: z.enum(['close-resolved', 'close-wontfix', 'label-stale', 'keep-open']),
    reason: z.string(),
    draftComment: z.string(),
  })),
});

export type StaleAnalysisResponse = z.infer<typeof StaleAnalysisResponseSchema>;

export function buildStaleAnalysisPrompt(
  candidates: Array<StoredIssue & { daysSinceUpdate: number }>,
  recentClosed: StoredIssue[],
  staleCloseDays: number,
): string {
  const issueList = candidates.map(formatCandidate).join('\n\n---\n\n');

  const closedSection = recentClosed.length > 0
    ? `\nRECENTLY CLOSED ISSUES (use for cross-referencing):\n${recentClosed.map(formatClosed).join('\n')}\n`
    : '';

  return `You are triaging stale GitHub issues — issues with no activity for a long time. For each issue, decide the best course of action.

DECISION OPTIONS:
- "close-resolved" — The issue was likely fixed by another issue/PR or is no longer reproducible. Draft a polite closing comment explaining why.
- "close-wontfix" — The issue is outdated, superseded, or no longer relevant. Draft a comment explaining the reasoning.
- "label-stale" — The issue might still be valid but needs author confirmation. Draft a comment asking if the issue is still relevant, noting it will be closed in ${staleCloseDays} days without activity.
- "keep-open" — The issue is clearly still relevant and unresolved. No comment needed (use empty string).

DECISION GUIDELINES BY CATEGORY:
- Bug: Check if a similar closed issue suggests it was fixed. If the bug is in a core feature and not clearly resolved, prefer "label-stale" over closing.
- Question: If the question was answered in comments or by a closed issue, close as resolved.
- Feature: If superseded by a different implementation or closed feature request, close as wontfix. If still valid, label-stale.
- Docs/Chore: Usually safe to close as wontfix if no longer relevant.

Rules:
- Be conservative — when in doubt, prefer "label-stale" over closing
- If recent comments show active discussion or someone working on the issue, prefer "keep-open"
- Draft comments should be polite and explain the reasoning
- For "keep-open", set draftComment to an empty string
- Reference related closed issues by number when relevant
${closedSection}
STALE ISSUES TO TRIAGE:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 42,
      "action": "label-stale",
      "reason": "No activity for 120 days, unclear if still reproducible",
      "draftComment": "This issue has been open for 120 days with no activity. Is this still relevant? If there's no response within ${staleCloseDays} days, we'll close it automatically."
    }
  ]
}`;
}

function formatCandidate(issue: StoredIssue & { daysSinceUpdate: number }): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const commentSection = formatCommentsForPrompt(issue.comments, {
    maxComments: 5,
    maxCharsPerComment: 300,
    maxTotalChars: 2000,
  });
  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea} | Days inactive: ${issue.daysSinceUpdate}
Summary: ${d.summary}
Comments: ${issue.commentCount} | Reactions: ${issue.reactions}${commentSection ? `\n${commentSection}` : ''}`;
}

function formatClosed(issue: StoredIssue): string {
  const d = issue.digest;
  const summary = d ? d.summary : issue.title;
  return `  #${issue.number} — ${issue.title} (${summary})`;
}
