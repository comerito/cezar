import { ActionGrid } from '@/components/action-grid';
import { ACTION_TILES } from '@/data/actions';
import { getActiveWorkspace } from '@/lib/workspace';
import { loadWorkspaceBadges } from './load-badges';
import { SyncButton } from './sync-button';

export default async function DashboardPage() {
  const workspace = await getActiveWorkspace();
  const badges = workspace ? await loadWorkspaceBadges(workspace.id) : undefined;

  return (
    <div className="px-8 py-6">
      <header className="mb-8 flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {ACTION_TILES.length} CEZAR actions
            {workspace && <> — {workspace.repoOwner}/{workspace.repoName}</>}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {workspace && <SyncButton />}
          {workspace && (
            <div className="text-xs text-fg-subtle">
              workspace: {workspace.slug}
            </div>
          )}
          {!workspace && (
            <div className="text-xs text-fg-subtle">
              no workspace connected
            </div>
          )}
        </div>
      </header>
      <ActionGrid badges={badges} />
    </div>
  );
}
