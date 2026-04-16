import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';
import { formatCommentsForPrompt } from '../../utils/comment-formatter.js';

export const NeedsResponseResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    status: z.enum(['needs-response', 'responded', 'new-issue']),
    reason: z.string(),
  })),
});

export type NeedsResponseResponse = z.infer<typeof NeedsResponseResponseSchema>;

export function buildNeedsResponsePrompt(candidates: StoredIssue[], orgMembers: string[]): string {
  const issueList = candidates.map(i => formatIssueForAnalysis(i, orgMembers)).join('\n\n---\n\n');
  const orgMemberList = orgMembers.length > 0
    ? `Org members / maintainers: ${orgMembers.join(', ')}`
    : 'No org member list available — use collaborator/author context clues.';

  return `You are analyzing GitHub issues to determine if they need a response from a maintainer or org member.

${orgMemberList}

For each issue below, classify it as one of:
- "new-issue" — no comments at all, needs initial triage/response
- "needs-response" — the last meaningful activity is from a community user (not an org member), and no org member has adequately addressed the issue or the user's latest question/concern
- "responded" — an org member has provided a meaningful response that addresses the issue or the user's latest concern

Important rules:
- A bot comment (e.g. from GitHub Actions, dependabot, or automated tools) does NOT count as a maintainer response
- Comments tagged with [ORG] are from org members/maintainers
- Look at the substance of the response — an org member saying "thanks for reporting" without addressing the issue still means it needs a real response
- If an org member asked for more info and the user provided it, that means it needs a new response from the org member
- If the issue author IS an org member and they're reporting a bug/feature, classify as "responded" (self-reported by team)

Provide a brief reason explaining your classification.

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 123,
      "status": "needs-response",
      "reason": "User asked a follow-up question 3 days ago with no org member reply"
    }
  ]
}`;
}

function formatIssueForAnalysis(issue: StoredIssue, orgMembers: string[]): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const orgSet = new Set(orgMembers.map(m => m.toLowerCase()));

  // Format comments with [ORG] tags
  const taggedComments = issue.comments.map(c => {
    const isOrg = orgSet.has(c.author.toLowerCase());
    return { ...c, author: isOrg ? `${c.author} [ORG]` : c.author };
  });

  const commentSection = taggedComments.length > 0
    ? formatCommentsForPrompt(taggedComments)
    : '(no comments)';

  const isAuthorOrg = orgSet.has(issue.author.toLowerCase());

  return `#${issue.number}${labels} — ${issue.title}
Author: ${issue.author}${isAuthorOrg ? ' [ORG]' : ''} | Category: ${d.category} | Area: ${d.affectedArea}
Comment count: ${issue.commentCount}
Body:
${issue.body.slice(0, 2000)}
${commentSection}`;
}
