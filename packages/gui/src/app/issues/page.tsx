import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { getActiveWorkspace } from '@/lib/workspace';
import type { StoredIssue } from '@cezar/core';
import { IssuesView, type IssueRow, type RunIndicatorStatus } from './issues-view';

export default async function IssuesPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <header className="mb-6">
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Issues</h1>
        </header>
        <EmptyState title="No workspace connected" body="Create a workspace first." />
      </div>
    );
  }

  let issues: StoredIssue[] = [];
  let latestRunByIssue = new Map<number, RunIndicatorStatus>();
  let loadError: string | null = null;
  let fetchedAt: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const [store, runStatuses] = await Promise.all([
      adapter.load(),
      fetchLatestRunStatusByIssue(workspace.id),
    ]);
    issues = store.issues;
    latestRunByIssue = runStatuses;
    fetchedAt = store.meta.lastSyncedAt ?? null;
  } catch (err) {
    loadError = (err as Error).message;
  }

  if (loadError) {
    return (
      <div className="px-6 py-6">
        <header className="mb-6">
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Issues</h1>
        </header>
        <EmptyState title="Load failed" body={loadError} tone="danger" />
      </div>
    );
  }

  const rows: IssueRow[] = issues.map((i) => ({
    number: i.number,
    title: i.title,
    htmlUrl: i.htmlUrl,
    state: i.state,
    priority: i.analysis.priority ?? null,
    issueType: i.analysis.issueType ?? null,
    labels: i.labels,
    commentCount: i.commentCount,
    runStatus: latestRunByIssue.get(i.number) ?? 'none',
    autofixStatus: i.analysis.autofixStatus ?? null,
  }));

  return (
    <IssuesView
      rows={rows}
      repoLabel={`${workspace.repoOwner}/${workspace.repoName}`}
      fetchedAt={fetchedAt}
      readOnly={workspace.role !== 'admin'}
    />
  );
}

/**
 * For each issue_number with any run or queued job, return the single
 * `RunIndicatorStatus` that best represents its current state. Precedence is
 * the latest workflow_runs row by `created_at`; if none exists but a
 * queued/claimed job does, treat as `queued`.
 *
 * Cost: two filtered scans of small tables (workflow_runs / jobs), collapsed
 * in JS. Acceptable until per-issue run counts grow large — at that point
 * promote to a Postgres view `latest_run_per_issue`.
 */
async function fetchLatestRunStatusByIssue(workspaceId: string): Promise<Map<number, RunIndicatorStatus>> {
  const supabase = createSupabaseAdminClient();

  const [{ data: runs }, { data: jobs }] = await Promise.all([
    supabase
      .from('workflow_runs')
      .select('issue_number, status, created_at')
      .eq('workspace_id', workspaceId)
      .not('issue_number', 'is', null)
      .order('created_at', { ascending: false }),
    supabase
      .from('jobs')
      .select('issue_number, status')
      .eq('workspace_id', workspaceId)
      .in('status', ['queued', 'claimed'])
      .not('issue_number', 'is', null),
  ]);

  const out = new Map<number, RunIndicatorStatus>();

  // Run rows arrive newest-first; first hit per issue wins.
  for (const r of runs ?? []) {
    if (r.issue_number == null) continue;
    if (out.has(r.issue_number)) continue;
    const mapped = mapRunStatus(r.status);
    if (mapped !== null) out.set(r.issue_number, mapped);
  }

  // Queued jobs upgrade `none`/missing entries to `queued`, but never
  // overwrite a real workflow_run status.
  for (const j of jobs ?? []) {
    if (j.issue_number == null) continue;
    if (!out.has(j.issue_number)) out.set(j.issue_number, 'queued');
  }

  return out;
}

function mapRunStatus(status: string): RunIndicatorStatus | null {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return null; // hidden
    default:
      return null;
  }
}

function EmptyState({
  title,
  body,
  tone = 'muted',
}: {
  title: string;
  body: string;
  tone?: 'muted' | 'danger';
}) {
  return (
    <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-8 text-center">
      <div className={tone === 'danger' ? 'text-error' : 'text-on-surface'}>{title}</div>
      <div className="mt-2 text-sm text-on-surface-variant">{body}</div>
    </div>
  );
}
