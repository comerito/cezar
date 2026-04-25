import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { getActiveWorkspace } from '@/lib/workspace';
import type { IssueAutofixCandidateStatus } from '@/lib/supabase/types';
import { ActivateButton } from './activate-button';
import { AutofixButton } from './autofix-button';
import type { StoredIssue } from '@cezar/core';

interface CandidateInfo {
  status: IssueAutofixCandidateStatus;
  matchedPrNumber: number | null;
  dispatchedFlowId: string | null;
}

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
  const candidates = new Map<number, CandidateInfo>();

  try {
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const store = await adapter.load();
    issues = store.issues;

    const { data: rows } = await supabase
      .from('issue_autofix_candidates')
      .select('issue_number, status, matched_pr_number, dispatched_flow_id')
      .eq('workspace_id', workspace.id);

    for (const row of rows ?? []) {
      candidates.set(row.issue_number, {
        status: row.status,
        matchedPrNumber: row.matched_pr_number,
        dispatchedFlowId: row.dispatched_flow_id,
      });
    }
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
      {!loadError && issues.length > 0 && (
        <IssueTable
          issues={issues}
          candidates={candidates}
          repoOwner={workspace.repoOwner}
          repoName={workspace.repoName}
        />
      )}
    </div>
  );
}

function IssueTable({
  issues,
  candidates,
  repoOwner,
  repoName,
}: {
  issues: StoredIssue[];
  candidates: Map<number, CandidateInfo>;
  repoOwner: string;
  repoName: string;
}) {
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
            <th className="px-4 py-3">Loop</th>
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
                    <span key={l} className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs text-fg-muted">
                      {l}
                    </span>
                  ))}
                  {issue.labels.length > 3 && (
                    <span className="text-xs text-fg-subtle">+{issue.labels.length - 3}</span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-fg-muted">{issue.commentCount}</td>
              <td className="px-4 py-3">
                <LoopCell
                  candidate={candidates.get(issue.number)}
                  issueNumber={issue.number}
                  repoOwner={repoOwner}
                  repoName={repoName}
                />
              </td>
              <td className="px-4 py-3">
                {issue.analysis.issueType === 'bug' && (issue.analysis.bugConfidence ?? 0) >= 0.7 && issue.analysis.autofixStatus !== 'pr-opened' ? (
                  <AutofixButton issueNumber={issue.number} />
                ) : issue.analysis.autofixStatus === 'pr-opened' ? (
                  <span className="text-xs text-accent">PR opened</span>
                ) : (
                  <span className="text-xs text-fg-subtle">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LoopCell({
  candidate,
  issueNumber,
  repoOwner,
  repoName,
}: {
  candidate: CandidateInfo | undefined;
  issueNumber: number;
  repoOwner: string;
  repoName: string;
}) {
  if (!candidate) return <span className="text-xs text-fg-subtle">—</span>;

  switch (candidate.status) {
    case 'pending_match':
      return <Pill tone="muted">checking…</Pill>;
    case 'matched_to_pr':
      if (candidate.matchedPrNumber == null) return <Pill tone="muted">matched</Pill>;
      return (
        <a
          href={`https://github.com/${repoOwner}/${repoName}/pull/${candidate.matchedPrNumber}`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent hover:text-accent-hover"
        >
          PR #{candidate.matchedPrNumber}
        </a>
      );
    case 'unmatched':
      return <Pill tone="muted">unmatched</Pill>;
    case 'notified':
      return <ActivateButton issueNumber={issueNumber} />;
    case 'dispatched':
      if (!candidate.dispatchedFlowId) return <Pill tone="muted">dispatched</Pill>;
      return (
        <a
          href={`/flows/cockpit/${candidate.dispatchedFlowId}`}
          className="text-xs text-accent hover:text-accent-hover"
        >
          → flow
        </a>
      );
    case 'resolved':
      return <Pill tone="success">resolved</Pill>;
    default:
      return <span className="text-xs text-fg-subtle">—</span>;
  }
}

function Pill({ tone, children }: { tone: 'muted' | 'success'; children: React.ReactNode }) {
  const cls =
    tone === 'success'
      ? 'bg-accent/15 text-accent'
      : 'bg-bg-subtle text-fg-muted';
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{children}</span>;
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
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${PRIORITY_COLORS[priority] ?? ''}`}>
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
      {confidence != null && <span className="text-xs text-fg-subtle">({Math.round(confidence * 100)}%)</span>}
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
