import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const WelcomeResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    welcomeMessage: z.string(),
  })),
});

export type WelcomeResponse = z.infer<typeof WelcomeResponseSchema>;

export function buildWelcomePrompt(
  candidates: StoredIssue[],
  repoOwner: string,
  repoName: string,
): string {
  const issueList = candidates.map(formatIssueForWelcome).join('\n\n---\n\n');

  return `You are writing personalized welcome comments for first-time contributors to the ${repoOwner}/${repoName} GitHub repository. Each person below has just filed their first issue.

GOALS:
- Thank the contributor by their GitHub username
- Acknowledge what they filed — show you read it
- Set expectations on response time (maintainers will review soon)
- If it's a bug: confirm receipt and gently ask for any missing reproduction steps if unclear
- If it's a feature request: explain that the team evaluates features based on alignment with the project roadmap
- If it's a question: point them to existing resources if relevant, and confirm someone will help

TONE:
- Warm and encouraging, but concise — no walls of text
- Professional but friendly
- Avoid generic platitudes — reference the specific issue content
- Keep it to 3-5 sentences maximum
- Do NOT use the word "welcome" more than once per message
- Use markdown formatting (bold for emphasis, backticks for code references)

ISSUES FROM FIRST-TIME CONTRIBUTORS:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 42,
      "welcomeMessage": "Thanks for reporting this, @username! The timeout behavior you described in the upload flow sounds like it could be related to the connection pooling config. We'll look into it — if you can share the exact error message from the console, that would help us narrow it down faster."
    }
  ]
}`;
}

function formatIssueForWelcome(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  return `#${issue.number}${labels} — ${issue.title}
Author: @${issue.author}
Category: ${d.category} | Area: ${d.affectedArea}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}`;
}
