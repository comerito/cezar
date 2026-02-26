import type { GitHubService } from './github.service.js';

/**
 * Formats a standalone audit comment for actions that don't post
 * their own content (e.g. label-only operations).
 */
export function formatAuditComment(actions: string[]): string {
  const date = new Date().toISOString().split('T')[0];
  const actionList = actions.map(a => `- ${a}`).join('\n');
  return `🤖 **CEZAR update** — ${date}\n\n${actionList}`;
}

/**
 * Appends an audit footer to an existing comment body.
 * Use this when the action already posts content (e.g. missing-info request).
 */
export function withAuditFooter(body: string, actions: string[]): string {
  const date = new Date().toISOString().split('T')[0];
  const actionList = actions.map(a => `- ${a}`).join('\n');
  return `${body}\n\n---\n🤖 **CEZAR update** — ${date}\n\n${actionList}`;
}

/**
 * Posts a standalone audit comment on an issue.
 * Use this for actions that don't post their own comment (label-only, close-only).
 */
export async function postAuditComment(
  github: GitHubService,
  issueNumber: number,
  actions: string[],
): Promise<void> {
  const body = formatAuditComment(actions);
  await github.addComment(issueNumber, body);
}
