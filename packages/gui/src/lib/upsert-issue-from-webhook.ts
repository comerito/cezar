import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/types';

/** The slice of a GitHub `issues` webhook payload's `issue` object we use. */
export interface WebhookIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels?: Array<{ name: string } | string> | null;
  assignees?: Array<{ login: string }> | null;
  user?: { login: string } | null;
  html_url: string;
  comments?: number | null;
  created_at: string;
  updated_at: string;
}

function labelNames(labels: WebhookIssue['labels']): string[] {
  if (!labels) return [];
  return labels.map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

/**
 * Phase 5 — upsert a single issue from a GitHub App `issues` webhook into the
 * workspace's issue store, so the `triage` job that follows has data to work
 * with. Mirrors the row shape `SupabaseStoreAdapter` / `api/cron/issue-sync`
 * write; on conflict it merges title/body/labels/state/etc. but does NOT touch
 * `digest`/`analysis` (those are owned by the pipeline). `content_hash` is
 * computed the same way `GitHubService` does so the store's change-detection
 * keeps working.
 */
export async function upsertIssueFromWebhook(
  adminSupabase: SupabaseClient<Database>,
  workspaceId: string,
  issue: WebhookIssue,
): Promise<void> {
  const core = await import('@cezar/core');
  const title = issue.title ?? '';
  const body = issue.body ?? '';
  // Mirrors api/cron/issue-sync's row shape — we intentionally omit `digest` /
  // `analysis` so an `edited` upsert doesn't clobber pipeline-owned data
  // (PostgREST `ON CONFLICT DO UPDATE` only sets the columns present here).
  const row = {
    workspace_id: workspaceId,
    number: issue.number,
    title,
    body,
    state: issue.state,
    labels: labelNames(issue.labels),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.user?.login ?? '',
    html_url: issue.html_url,
    content_hash: core.contentHash(title, body),
    comment_count: issue.comments ?? 0,
    reactions: 0,
  };
  const { error } = await adminSupabase
    .from('issues')
    .upsert(row as Database['public']['Tables']['issues']['Insert'], { onConflict: 'workspace_id,number' });
  if (error) throw new Error(`issue upsert failed: ${error.message}`);
}
