import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const ReleaseNotesResponseSchema = z.object({
  sections: z.array(z.object({
    heading: z.string(),
    emoji: z.string(),
    items: z.array(z.object({
      description: z.string(),
      issues: z.array(z.number()),
    })),
  })),
  contributors: z.array(z.object({
    username: z.string(),
    isFirstTime: z.boolean(),
  })),
});

export type ReleaseNotesResponse = z.infer<typeof ReleaseNotesResponseSchema>;

export function buildReleaseNotesPrompt(issues: StoredIssue[], allAuthors: Set<string>, versionTag?: string): string {
  const issueList = issues.map(formatIssueForNotes).join('\n');
  const previousAuthors = [...allAuthors].join(', ') || '(none)';
  const versionNote = versionTag ? `\nVersion tag: ${versionTag}` : '';

  return `You are generating structured release notes from closed GitHub issues.${versionNote}

CLOSED ISSUES FOR THIS RELEASE:
${issueList}

PREVIOUSLY KNOWN CONTRIBUTORS: ${previousAuthors}
(A contributor is "first-time" if their username is NOT in the list above)

Rules:
- Group issues into logical sections by category
- Section ordering preference: Security > Bug Fixes > New Features > Performance > Documentation > Other
- Write clean prose descriptions — do NOT just copy the issue title verbatim
- Merge related issues into a single entry when they cover the same fix/feature
- Each item must reference the issue number(s) it covers
- Use appropriate emoji for each section heading (🔒 Security, 🐛 Bug Fixes, ✨ New Features, ⚡ Performance, 📚 Documentation, 🔧 Other)
- Include all issue authors in the contributors list
- Mark first-time contributors based on the PREVIOUSLY KNOWN CONTRIBUTORS list

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "sections": [
    {
      "heading": "Bug Fixes",
      "emoji": "🐛",
      "items": [
        {
          "description": "Fix cart total not updating after applying discount code",
          "issues": [123, 156]
        }
      ]
    }
  ],
  "contributors": [
    { "username": "alice", "isFirstTime": false },
    { "username": "bob", "isFirstTime": true }
  ]
}`;
}

function formatIssueForNotes(issue: StoredIssue): string {
  const d = issue.digest!;
  return `  #${issue.number} — ${issue.title} | Author: @${issue.author} | Category: ${d.category} | Area: ${d.affectedArea} | Summary: ${d.summary}`;
}
