import { ActionGrid } from '@/components/action-grid';
import { ACTION_TILES } from '@/data/actions';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadWorkspaceBadges } from './load-badges';
import { loadRepoStats } from './load-stats';
import { SyncButton } from './sync-button';

export default async function DashboardPage() {
  const workspace = await getActiveWorkspace();
  const [badges, stats] = await Promise.all([
    workspace ? loadWorkspaceBadges(workspace.id) : undefined,
    workspace ? loadRepoStats(workspace.id) : null,
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
      <ActionGrid badges={badges} />
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
