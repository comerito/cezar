import Link from 'next/link';
import { ActionGrid } from '@/components/action-grid';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadAutofixLoopStats, type AutofixLoopStats } from './load-autofix-loop';
import { loadWorkspaceBadges } from './load-badges';
import { loadRepoStats } from './load-stats';
import { SyncButton } from './sync-button';

export default async function DashboardPage() {
  const workspace = await getActiveWorkspace();
  const [badges, stats, loopStats] = await Promise.all([
    workspace ? loadWorkspaceBadges(workspace.id) : undefined,
    workspace ? loadRepoStats(workspace.id) : null,
    workspace ? loadAutofixLoopStats(workspace.id) : null,
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
      {loopStats && loopStats.mode !== 'off' && <AutofixLoopCard stats={loopStats} />}
      <ActionGrid badges={badges} />
    </div>
  );
}

function AutofixLoopCard({ stats }: { stats: AutofixLoopStats }) {
  // Subtle accent only when there's a pending one-click — otherwise the card
  // is informational and shouldn't compete with the action grid below.
  const accent = stats.notified > 0 ? 'border-accent/30 bg-accent/5' : 'border-border bg-bg-elevated';
  return (
    <div className={`mb-6 flex items-center justify-between rounded-lg border ${accent} px-5 py-4`}>
      <div className="flex items-center gap-8">
        <div>
          <div className="text-sm font-medium text-fg">Issue autofix loop</div>
          <div className="text-xs text-fg-subtle">mode: {stats.mode}</div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <Stat label="Notified" value={stats.notified} color={stats.notified > 0 ? 'accent' : 'muted'} />
          <Stat label="Dispatched" value={stats.dispatched} color="muted" />
          <Stat label="Matched" value={stats.matchedToPr} color="muted" />
        </div>
      </div>
      <Link href="/issues" className="text-sm text-accent hover:text-accent-hover">
        → Triage
      </Link>
    </div>
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
