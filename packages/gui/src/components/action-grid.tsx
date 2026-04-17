'use client';

import { useActionState } from 'react';
import { ACTION_GROUP_LABELS, ACTION_TILES, type ActionGroup, type ActionTile } from '@/data/actions';
import { runAction, type RunActionState } from '@/app/dashboard/actions';
import type { ActionBadge } from '@/lib/badges';
import { cn } from './ui/cn';

const GROUP_ORDER: ActionGroup[] = ['triage', 'intelligence', 'community', 'release'];

interface ActionGridProps {
  badges?: Record<string, ActionBadge>;
}

export function ActionGrid({ badges }: ActionGridProps) {
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
                <ActionTileCard key={tile.id} tile={tile} badge={badges?.[tile.id]} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const EXCLUDED_FROM_RUN = new Set(['autofix', 'contributor-welcome', 'release-notes', 'issue-check']);

function ActionTileCard({ tile, badge }: { tile: ActionTile; badge?: ActionBadge }) {
  const [state, formAction, pending] = useActionState<RunActionState, FormData>(runAction, {});
  const disabled = badge && badge.available !== true;
  const canRun = !disabled && !EXCLUDED_FROM_RUN.has(tile.id);

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4 transition-colors',
        disabled ? 'opacity-50' : 'hover:border-accent/40',
        tile.flag === 'headline' && !disabled && 'border-accent/30',
      )}
      title={disabled ? String(badge!.available) : undefined}
    >
      <div className="flex items-center justify-between">
        <span className="text-xl" aria-hidden>{tile.icon}</span>
        <div className="flex items-center gap-1.5">
          {tile.flag && (
            <span className="rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-muted">
              {tile.flag}
            </span>
          )}
          {canRun && (
            <form action={formAction}>
              <input type="hidden" name="actionId" value={tile.id} />
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-accent px-2.5 py-1 text-[10px] font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? 'Running...' : 'Run'}
              </button>
            </form>
          )}
        </div>
      </div>
      <div className="text-sm font-medium text-fg">{tile.label}</div>
      <div className="text-xs leading-snug text-fg-muted">{tile.description}</div>
      {badge ? (
        <div className={cn(
          'mt-1 text-[11px]',
          badge.badge === 'up to date' || badge.badge === 'nothing to fix'
            ? 'text-fg-subtle'
            : 'text-accent',
        )}>
          {badge.badge}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-fg-subtle">no store loaded</div>
      )}
      {state.actionId === tile.id && state.ok && (
        <div className="text-[10px] text-accent">Done</div>
      )}
      {state.actionId === tile.id && state.error && (
        <div className="text-[10px] text-danger">{state.error}</div>
      )}
    </div>
  );
}
