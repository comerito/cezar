import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { getActiveWorkspace } from '@/lib/workspace';
import type { StoredIssue } from '@cezar/core';
import { fetchRecentActionRuns, type ActionRunSummary } from '@/lib/action-runs-loader';
import { IssuesView, type IssueRow } from './issues-view';

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
  let actionRunsByIssue = new Map<number, ActionRunSummary[]>();
  let loadError: string | null = null;
  let fetchedAt: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const [store, runs] = await Promise.all([
      adapter.load(),
      fetchRecentActionRuns(workspace.id, 'issue'),
    ]);
    issues = store.issues;
    actionRunsByIssue = runs;
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
    actionRuns: actionRunsByIssue.get(i.number) ?? [],
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
