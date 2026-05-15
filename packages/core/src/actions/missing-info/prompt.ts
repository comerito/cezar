import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';
import { formatCommentsForPrompt } from '../../utils/comment-formatter.js';

export const MissingInfoResponseSchema = z.object({
  results: z.array(z.object({
    number: z.number(),
    hasMissingInfo: z.boolean(),
    missingFields: z.array(z.string()),
    suggestedComment: z.string(),
  })),
});

export type MissingInfoResponse = z.infer<typeof MissingInfoResponseSchema>;

export function buildMissingInfoPrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForAnalysis).join('\n\n---\n\n');

  return `You are analyzing GitHub bug reports to determine if they are missing critical information needed to reproduce and fix the issue.

For each bug report below, determine what information is missing. Be context-aware:
- A database issue needs: schema details, query, database version, error message
- A UI issue needs: browser, OS, screen size, steps to reproduce
- An API issue needs: endpoint, request body, response, HTTP status code
- A CLI issue needs: command run, OS, version, terminal output
- A crash/error needs: full error message, stack trace, steps to reproduce
- All bugs need: steps to reproduce, expected vs actual behavior

If the issue already contains sufficient information to investigate, set hasMissingInfo to false.
- IMPORTANT: Check if the missing information was already provided in the comments below. If the comments already contain the needed info (e.g., reproduction steps, version, error message), set hasMissingInfo to false.

For issues with missing info, write a polite, specific GitHub comment asking for exactly what is needed. Do NOT use a generic template — tailor the questions to what this specific issue is about. Keep comments concise (3-5 bullet points max).

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "results": [
    {
      "number": 123,
      "hasMissingInfo": true,
      "missingFields": ["reproduction steps", "Node.js version"],
      "suggestedComment": "Thanks for reporting this! To help us investigate, could you share:\\n\\n1. Steps to reproduce the issue\\n2. Your Node.js version\\n\\nThis will help us diagnose and fix the issue faster."
    }
  ]
}`;
}

function formatIssueForAnalysis(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  const commentSection = formatCommentsForPrompt(issue.comments);
  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea}
Body:
${issue.body.slice(0, 3000)}${commentSection ? `\n${commentSection}` : ''}`;
}
