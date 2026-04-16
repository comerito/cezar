import { ActionGrid } from '@/components/action-grid';
import { ACTION_TILES } from '@/data/actions';

export default function DashboardPage() {
  return (
    <div className="px-8 py-6">
      <header className="mb-8 flex items-end justify-between border-b border-border pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {ACTION_TILES.length} CEZAR actions — pick one to run on the current workspace.
          </p>
        </div>
        <div className="text-xs text-fg-subtle">
          no workspace connected yet
        </div>
      </header>
      <ActionGrid />
    </div>
  );
}
