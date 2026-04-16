import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const CategorizeResponseSchema = z.object({
  categories: z.array(z.object({
    number: z.number(),
    category: z.enum(['framework', 'domain', 'integration']),
    reason: z.string(),
  })),
});

export type CategorizeResponse = z.infer<typeof CategorizeResponseSchema>;

export function buildCategorizePrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForCategorizing).join('\n\n---\n\n');

  return `You are categorizing GitHub feature issues into one of three categories:

CATEGORIES:
  - framework — Core framework functionality: foundational capabilities, architecture, CLI infrastructure, plugin systems, configuration, core APIs, base abstractions, and internal tooling that other features build upon.
  - domain — Domain-specific functionality: business logic, domain models, workflows, rules, and features tied to the specific problem domain the project addresses. These are features that make sense only in the context of this project's purpose.
  - integration — External integrations: connections to third-party services, APIs, databases, external tools, platforms, CI/CD systems, cloud providers, or any feature that bridges the project with an outside system.

RULES:
- Only categorize issues that are feature requests or enhancements. If an issue is clearly a bug report, documentation, question, or chore — still assign the best-fit category based on which area the feature/change touches.
- Each issue gets exactly one category.
- Base your decision on the issue title, summary, body, and keywords.

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "categories": [
    {
      "number": 123,
      "category": "framework",
      "reason": "Adds a new plugin loading mechanism to the core CLI"
    }
  ]
}`;
}

function formatIssueForCategorizing(issue: StoredIssue): string {
  const d = issue.digest!;
  const currentLabels = issue.labels.length > 0 ? issue.labels.join(', ') : '(none)';
  return `#${issue.number} — ${issue.title}
Labels: ${currentLabels}
Category: ${d.category} | Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Summary: ${d.summary}
Body:
${issue.body.slice(0, 2000)}`;
}
