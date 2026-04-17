import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { getActiveWorkspace } from '@/lib/workspace';
import { AutofixButton } from './autofix-button';
import type { StoredIssue } from '@cezar/core';

export default async function IssuesPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <header className="mb-6 border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
        </header>
        <EmptyState title="No workspace connected" body="Create a workspace first." />
      </div>
    );
  }

  let issues: StoredIssue[] = [];
  let loadError: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const store = await adapter.load();
    issues = store.issues;
  } catch (err) {
    loadError = (err as Error).message;
  }

  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Issues</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {workspace.repoOwner}/{workspace.repoName} — {issues.length} issues
        </p>
      </header>

      {loadError && <EmptyState title="Load failed" body={loadError} tone="danger" />}
      {!loadError && issues.length === 0 && (
        <EmptyState title="No issues yet" body="Sync issues to the workspace to see them here." />
      )}
      {!loadError && issues.length > 0 && <IssueTable issues={issues} />}
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
            <th className="px-4 py-3">Labels</th>
            <th className="px-4 py-3">Comments</th>
            <th className="px-4 py-3">Autofix</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {issues.map((issue) => (
            <tr key={issue.number} className="bg-bg hover:bg-bg-elevated">
              <td className="px-4 py-3 font-mono text-fg-muted">#{issue.number}</td>
              <td className="max-w-md px-4 py-3">
                <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="hover:text-accent">
                  {issue.title}
                </a>
              </td>
              <td className="px-4 py-3">
                <span className={issue.state === 'open' ? 'text-accent' : 'text-fg-muted'}>
                  {issue.state}
                </span>
              </td>
              <td className="px-4 py-3">
                <PriorityChip priority={issue.analysis.priority} />
              </td>
              <td className="px-4 py-3">
                <TypeChip type={issue.analysis.issueType} confidence={issue.analysis.bugConfidence} />
              </td>
              <td className="max-w-[180px] px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {issue.labels.slice(0, 3).map((l) => (
                    <span key={l} className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-fg-muted">
                      {l}
                    </span>
                  ))}
                  {issue.labels.length > 3 && (
                    <span className="text-[10px] text-fg-subtle">+{issue.labels.length - 3}</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-fg-muted">{issue.commentCount}</td>
              <td className="px-4 py-3">
                {issue.analysis.issueType === 'bug' && (issue.analysis.bugConfidence ?? 0) >= 0.7 && issue.analysis.autofixStatus !== 'pr-opened' ? (
                  <AutofixButton issueNumber={issue.number} />
                ) : issue.analysis.autofixStatus === 'pr-opened' ? (
                  <span className="text-[10px] text-accent">PR opened</span>
                ) : (
                  <span className="text-[10px] text-fg-subtle">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-orange-500/20 text-orange-400',
  medium: 'bg-yellow-500/20 text-yellow-400',
  low: 'bg-fg-subtle/20 text-fg-subtle',
};

function PriorityChip({ priority }: { priority: string | null | undefined }) {
  if (!priority) return <span className="text-fg-subtle">—</span>;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${PRIORITY_COLORS[priority] ?? ''}`}>
      {priority}
    </span>
  );
}

const TYPE_ICONS: Record<string, string> = { bug: '🐛', feature: '✨', question: '❓', other: '📦' };

function TypeChip({ type, confidence }: { type: string | null | undefined; confidence: number | null | undefined }) {
  if (!type) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
      {TYPE_ICONS[type] ?? ''} {type}
      {confidence != null && <span className="text-[10px] text-fg-subtle">({Math.round(confidence * 100)}%)</span>}
    </span>
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
