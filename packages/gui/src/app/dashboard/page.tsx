import Link from 'next/link';
import { ActionGrid } from '@/components/action-grid';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadAgentRunStats, type AgentRunStats } from './load-agent-runs';
import { loadWorkspaceBadges } from './load-badges';
import { loadRepoStats } from './load-stats';
import { SyncButton } from './sync-button';
import { ExtLink } from './ext-link';
import { RunStatusBadge } from '@/app/cockpit/cockpit-ui';

export default async function DashboardPage() {
  const workspace = await getActiveWorkspace();
  const [badges, stats, agentRuns] = await Promise.all([
    workspace ? loadWorkspaceBadges(workspace.id) : undefined,
    workspace ? loadRepoStats(workspace.id) : null,
    workspace ? loadAgentRunStats(workspace.id) : null,
  ]);

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            {workspace && (
              <p className="mt-1 text-sm text-fg-muted">
                {workspace.repoOwner}/{workspace.repoName}
              </p>
            )}
          </div>
          <div className="flex items-center gap-4">
            {workspace && <SyncButton />}
          </div>
        </div>

        {workspace && stats && (
          <div className="mt-4 flex items-center gap-6 text-sm">
            <Stat label="Open" value={stats.openIssues} color="accent" />
            <Stat label="Closed" value={stats.closedIssues} color="muted" />
            <Stat label="PRs open" value={stats.openPRs} color="accent" />
            <Stat label="Digested" value={stats.digested} color="muted" />
            <Stat label="Bugs" value={stats.bugs} color="danger" />
            {stats.lastSyncedAt && (
              <span className="text-xs text-fg-subtle">
                synced {formatRelative(stats.lastSyncedAt)}
              </span>
            )}
          </div>
        )}
      </header>
      {agentRuns && <AgentRunsCard stats={agentRuns} repoOwner={workspace?.repoOwner ?? ''} repoName={workspace?.repoName ?? ''} />}
      <ActionGrid badges={badges} />
    </div>
  );
}

function AgentRunsCard({
  stats,
  repoOwner,
  repoName,
}: {
  stats: AgentRunStats;
  repoOwner: string;
  repoName: string;
}) {
  const active = stats.running > 0 || stats.paused > 0;
  const accent = active ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-elevated';
  return (
    <Link href="/cockpit" className={`mb-6 block rounded-lg border ${accent} px-5 py-4 transition-colors hover:border-accent/40`}>
      <div className="flex items-start justify-between gap-8">
        <div className="flex items-start gap-8">
          <div>
            <div className="text-sm font-medium text-fg">Agent runs</div>
            <div className="text-xs text-fg-subtle">autofix · CI follow-up · triage</div>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <Stat label="Running" value={stats.running} color={stats.running > 0 ? 'accent' : 'muted'} />
            <Stat label="Paused" value={stats.paused} color={stats.paused > 0 ? 'accent' : 'muted'} />
            <Stat label="Queued" value={stats.queued} color="muted" />
            <Stat label="Failed (24h)" value={stats.failedLast24h} color={stats.failedLast24h > 0 ? 'danger' : 'muted'} />
          </div>
        </div>
        {stats.recentRuns.length > 0 && (
          <div className="min-w-0 flex-1 space-y-1">
            {stats.recentRuns.map((r) => {
              const ref =
                r.pr_number != null ? `PR #${r.pr_number}` : r.issue_number != null ? `#${r.issue_number}` : r.id.slice(0, 8);
              const gh =
                r.pr_number != null
                  ? `https://github.com/${repoOwner}/${repoName}/pull/${r.pr_number}`
                  : r.issue_number != null
                    ? `https://github.com/${repoOwner}/${repoName}/issues/${r.issue_number}`
                    : null;
              return (
                <div key={r.id} className="flex items-center gap-2 text-xs">
                  <RunStatusBadge status={r.status} />
                  <span className="text-fg-muted">{r.workflow}</span>
                  {gh ? (
                    <ExtLink href={gh} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                      {ref}
                    </ExtLink>
                  ) : (
                    <span className="text-fg-subtle">{ref}</span>
                  )}
                  <span className="text-fg-subtle">{formatRelative(r.started_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Link>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: 'accent' | 'muted' | 'danger' }) {
  const colors = { accent: 'text-accent', muted: 'text-fg', danger: 'text-danger' };
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-lg font-semibold ${colors[color]}`}>{value}</span>
      <span className="text-xs text-fg-subtle">{label}</span>
    </div>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
