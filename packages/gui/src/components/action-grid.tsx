import { ACTION_GROUP_LABELS, ACTION_TILES, type ActionGroup, type ActionTile } from '@/data/actions';
import { cn } from './ui/cn';

const GROUP_ORDER: ActionGroup[] = ['triage', 'intelligence', 'community', 'release'];

export function ActionGrid() {
  return (
    <div className="flex flex-col gap-8">
      {GROUP_ORDER.map((group) => {
        const tiles = ACTION_TILES.filter((t) => t.group === group);
        if (tiles.length === 0) return null;
        return (
          <section key={group}>
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">
              {ACTION_GROUP_LABELS[group]}
            </h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
              {tiles.map((tile) => (
                <ActionTileCard key={tile.id} tile={tile} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ActionTileCard({ tile }: { tile: ActionTile }) {
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4 transition-colors hover:border-accent/40',
        tile.flag === 'headline' && 'border-accent/30',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xl" aria-hidden>{tile.icon}</span>
        {tile.flag && (
          <span className="rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
            {tile.flag}
          </span>
        )}
      </div>
      <div className="text-sm font-medium text-fg">{tile.label}</div>
      <div className="text-xs leading-snug text-fg-muted">{tile.description}</div>
      <div className="mt-1 text-[11px] text-fg-subtle">id: {tile.id}</div>
    </div>
  );
}
