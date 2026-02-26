import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const MilestonePlanResponseSchema = z.object({
  milestones: z.array(z.object({
    name: z.string(),
    theme: z.string(),
    issues: z.array(z.number()),
    effort: z.enum(['small', 'medium', 'large']),
    rationale: z.string(),
  })),
  unassigned: z.array(z.number()),
});

export type MilestonePlanResponse = z.infer<typeof MilestonePlanResponseSchema>;

export function buildMilestonePlanPrompt(issues: StoredIssue[]): string {
  const issueList = issues.map(formatIssueForPlanning).join('\n');

  return `You are a release planner grouping open GitHub issues into logical milestones.

OPEN ISSUES:
${issueList}

Rules:
- Create 2-4 milestones, each representing a coherent, shippable release
- Group issues by theme (e.g. "Auth & Security", "Performance", "Developer Experience")
- Critical and high priority issues should appear in earlier milestones
- Each milestone should have a descriptive name (e.g. "v-next — Auth Overhaul")
- Each milestone should have a clear theme explaining what it achieves
- Effort estimate: small (1-2 weeks), medium (2-4 weeks), large (4+ weeks)
- Issues that don't fit any theme go in the "unassigned" array
- Every issue number must appear exactly once — either in a milestone or in unassigned
- Provide a rationale for each milestone explaining why these issues belong together

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "milestones": [
    {
      "name": "v-next — Auth & Security",
      "theme": "Authentication and security improvements",
      "issues": [89, 178, 203],
      "effort": "medium",
      "rationale": "Groups all auth-related bugs and security findings for a focused security release"
    }
  ],
  "unassigned": [201]
}`;
}

function formatIssueForPlanning(issue: StoredIssue): string {
  const d = issue.digest!;
  const priority = issue.analysis.priority ?? 'unscored';
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  return `  #${issue.number} ${priority.padEnd(9)}${labels} — ${issue.title} | Category: ${d.category} | Area: ${d.affectedArea} | Summary: ${d.summary}`;
}
