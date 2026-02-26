import { z } from 'zod';
import type { StoredIssue } from '../../store/store.model.js';

export const SecurityResponseSchema = z.object({
  findings: z.array(z.object({
    number: z.number(),
    isSecurityRelated: z.boolean(),
    confidence: z.number().min(0).max(1),
    category: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    explanation: z.string(),
  })),
});

export type SecurityResponse = z.infer<typeof SecurityResponseSchema>;

export function buildSecurityPrompt(candidates: StoredIssue[]): string {
  const issueList = candidates.map(formatIssueForScan).join('\n\n---\n\n');

  return `You are performing a security triage of GitHub issues. Your goal is to identify issues that have security implications, even if they are not explicitly labeled as security issues.

DETECTION CATEGORIES:
- Authentication bypass — login/session issues that could allow unauthorized access
- Session hijacking — session fixation, cookie theft, token leakage
- Privilege escalation — users gaining access beyond their role
- Injection — SQL injection, command injection, path traversal, XSS, template injection
- Data exposure — API keys in logs, PII leakage, sensitive data in error responses
- Credential logging — passwords or tokens written to logs/console
- Dependency vulnerabilities — known CVEs in libraries, outdated packages with security fixes

Rules:
- Analyze the FULL issue body carefully — security details are often subtle
- Set confidence based on how clearly the issue describes a security problem (0.0-1.0)
- Only return isSecurityRelated: true when confidence >= 0.70
- False positives are acceptable — it's better to flag and review than to miss a vulnerability
- For non-security issues, set isSecurityRelated: false (category, severity, explanation can be empty)
- Severity should reflect the potential impact if the security issue is exploited

ISSUES:
${issueList}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "findings": [
    {
      "number": 178,
      "isSecurityRelated": true,
      "confidence": 0.94,
      "category": "data exposure",
      "severity": "high",
      "explanation": "API key is included in error response body visible to end users"
    }
  ]
}`;
}

function formatIssueForScan(issue: StoredIssue): string {
  const d = issue.digest!;
  const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
  return `#${issue.number}${labels} — ${issue.title}
Category: ${d.category} | Area: ${d.affectedArea} | Keywords: ${d.keywords.join(', ')}
Summary: ${d.summary}
Full body:
${issue.body.slice(0, 4000)}`;
}
