import { z } from 'zod';
import { ROOT_CAUSE_ANALYSIS_SKILL } from '../skills.js';

export const RootCauseSchema = z.object({
  summary: z.string(),
  suspectedFiles: z.array(z.string()),
  hypothesis: z.string(),
  reproductionNotes: z.string().optional(),
  confidence: z.number().min(0).max(1),
});

export type RootCause = z.infer<typeof RootCauseSchema>;

export const ANALYZER_SYSTEM_PROMPT = `You are the ANALYZER agent. Your single job is to locate the root cause of a GitHub issue.

RULES:
- You have READ-ONLY tools (Read, Grep, Glob, and read-only Bash like \`git log\`, \`git diff\`, \`git show\`).
- Do NOT edit any files.
- Use Grep/Glob to locate relevant symbols, then Read the suspect files end to end.
- Stop as soon as you have a defensible hypothesis — don't over-explore.
- Do NOT search the repo for skill/doc files. Everything you need is in this prompt.

${ROOT_CAUSE_ANALYSIS_SKILL}

OUTPUT — when ready, output ONLY a single JSON object (no markdown fences, no prose before or after) matching this schema:
{
  "summary": "one-line description of the bug",
  "suspectedFiles": ["path/to/file.ts", "..."],
  "hypothesis": "2-4 sentences explaining the root cause",
  "reproductionNotes": "optional: how the bug is triggered",
  "confidence": 0.0 to 1.0
}`;

const BODY_MAX_CHARS = 3000;
const COMMENT_MAX_CHARS = 800;
const MAX_COMMENTS = 10;

export function buildAnalyzerUserPrompt(opts: {
  issueNumber: number;
  title: string;
  body: string;
  comments: Array<{ author: string; body: string; createdAt: string }>;
  digest?: { summary: string; affectedArea: string; keywords: string[] };
  priorAttemptNotes?: string;
}): string {
  const body = truncate(opts.body, BODY_MAX_CHARS);

  // Keep the most recent MAX_COMMENTS comments (earliest thread context is
  // usually subsumed by the body — the latest discussion is where the
  // additional signal lives).
  const recentComments = opts.comments.slice(-MAX_COMMENTS);
  const commentCountNote = opts.comments.length > MAX_COMMENTS
    ? `\n[… ${opts.comments.length - MAX_COMMENTS} older comment(s) omitted]`
    : '';
  const comments = recentComments.length > 0
    ? recentComments
        .map(c => `@${c.author} (${c.createdAt}):\n${truncate(c.body, COMMENT_MAX_CHARS)}`)
        .join('\n\n---\n\n') + commentCountNote
    : '(no comments)';

  const digestSection = opts.digest
    ? `\n\nDIGEST (pre-computed by cezar — use as a starting hint; do not re-derive):
  summary:      ${opts.digest.summary}
  affectedArea: ${opts.digest.affectedArea}
  keywords:     ${opts.digest.keywords.join(', ')}`
    : '';

  const priorSection = opts.priorAttemptNotes
    ? `\n\nPRIOR ATTEMPT — the previous fix was rejected at review. Blocker-level reviewer notes:\n${opts.priorAttemptNotes}\n\nUse these notes to refine the root-cause analysis. Do not re-explore areas the previous attempt already covered unless the reviewer flagged them.`
    : '';

  return `ISSUE #${opts.issueNumber}: ${opts.title}${digestSection}

BODY (truncated to ${BODY_MAX_CHARS} chars):
${body}

COMMENTS:
${comments}${priorSection}

Investigate and produce the JSON object described in the system prompt.`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}\n[… truncated, original was ${str.length} chars]`;
}
