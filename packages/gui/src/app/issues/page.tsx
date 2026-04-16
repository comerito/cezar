import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import type { StoredIssue } from '@cezar/core';

type LoadResult =
  | { kind: 'ok'; issues: StoredIssue[]; owner: string; repo: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

async function loadFirstWorkspaceIssues(): Promise<LoadResult> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: workspaces, error } = await supabase
      .from('workspaces')
      .select('id, repo_owner, repo_name')
      .limit(1);
    if (error) return { kind: 'error', message: error.message };
    const workspace = workspaces?.[0];
    if (!workspace) return { kind: 'empty' };

    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const store = await adapter.load();
    return { kind: 'ok', issues: store.issues, owner: workspace.repo_owner, repo: workspace.repo_name };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

export default async function IssuesPage() {
  const result = await loadFirstWorkspaceIssues();

  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {result.kind === 'ok'
            ? `${result.owner}/${result.repo} — ${result.issues.length} issues`
            : result.kind === 'empty'
              ? 'No workspace connected yet.'
              : `Unable to load workspace: ${result.message}`}
        </p>
      </header>

      {result.kind === 'ok' && result.issues.length > 0 && (
        <IssueTable issues={result.issues} />
      )}

      {result.kind === 'ok' && result.issues.length === 0 && (
        <EmptyState
          title="No issues yet"
          body="Run `cezar init` against the workspace repo to pull issues, then they'll appear here."
        />
      )}

      {result.kind === 'empty' && (
        <EmptyState
          title="No workspace connected"
          body="Create a workspace row in Supabase and link it to a GitHub repo. Workspace CRUD UI lands in Phase 1."
        />
      )}

      {result.kind === 'error' && (
        <EmptyState
          title="Load failed"
          body={result.message}
          tone="danger"
        />
      )}
    </div>
  );
}

function IssueTable({ issues }: { issues: StoredIssue[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-bg-elevated text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="px-4 py-3">#</th>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3">State</th>
            <th className="px-4 py-3">Priority</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Comments</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {issues.map((issue) => (
            <tr key={issue.number} className="bg-bg hover:bg-bg-elevated">
              <td className="px-4 py-3 font-mono text-fg-muted">#{issue.number}</td>
              <td className="px-4 py-3">
                <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
                  {issue.title}
                </a>
              </td>
              <td className="px-4 py-3">
                <span className={issue.state === 'open' ? 'text-accent' : 'text-fg-muted'}>
                  {issue.state}
                </span>
              </td>
              <td className="px-4 py-3 text-fg-muted">{issue.analysis.priority ?? '—'}</td>
              <td className="px-4 py-3 text-fg-muted">{issue.analysis.issueType ?? '—'}</td>
              <td className="px-4 py-3 text-fg-muted">{issue.commentCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center">
      <div className={tone === 'danger' ? 'text-danger' : 'text-fg'}>{title}</div>
      <div className="mt-2 text-sm text-fg-muted">{body}</div>
    </div>
  );
}
