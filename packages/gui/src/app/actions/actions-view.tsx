'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import {
  RefreshIcon,
  PlusIcon,
  SearchIcon,
  StatusDotIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreVerticalIcon,
} from '@/components/icons';
import { seedDefaultsForCurrentWorkspace } from './actions-page-actions';

export interface ActionRow {
  id: string;
  name: string;
  kind: 'built-in' | 'user';
  description: string | null;
  target: 'issue' | 'pr';
  triggers: string[];
  /** Number of declared effects, or `null` when the action runs in tool-use mode. */
  effectsDeclared: number | null;
  status: 'enabled' | 'disabled';
  updatedAt: string | null;
  replacesBuiltIn: string | null;
  /** True when a built-in with the same name still exists alongside a user override. */
  hasBuiltinShadow: boolean;
}

interface ActionsViewProps {
  rows: ActionRow[];
  readOnly: boolean;
  autoTriageActionId: string | null;
}

type KindFilter = 'all' | ActionRow['kind'];
type TargetFilter = 'all' | ActionRow['target'];
type StatusFilter = 'all' | ActionRow['status'];
type TriggerFilter = 'all' | string;

type SortKey = 'name' | 'kind' | 'target' | 'triggers' | 'effects' | 'status' | 'updatedAt';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function ActionsView({ rows, readOnly, autoTriageActionId }: ActionsViewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [targetFilter, setTargetFilter] = useState<TargetFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [seedState, setSeedState] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [seeding, startSeed] = useTransition();

  const distinctTriggers = useMemo(() => {
    const out = new Set<string>();
    for (const r of rows) for (const t of r.triggers) out.add(t);
    return Array.from(out).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (targetFilter !== 'all' && r.target !== targetFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (triggerFilter !== 'all' && !r.triggers.includes(triggerFilter)) return false;
      if (q.length > 0) {
        const hay = `${r.name} ${r.description ?? ''} ${r.triggers.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, kindFilter, targetFilter, triggerFilter, statusFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => dir * compareByKey(a, b, sortKey));
    return out;
  }, [filtered, sortKey, sortDir]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const totalActions = rows.length;
  const enabledCount = rows.filter((r) => r.status === 'enabled').length;
  const builtinCount = rows.filter((r) => r.kind === 'built-in').length;
  const userCount = rows.filter((r) => r.kind === 'user').length;

  const filtersActive =
    search.trim().length > 0 ||
    kindFilter !== 'all' ||
    targetFilter !== 'all' ||
    triggerFilter !== 'all' ||
    statusFilter !== 'all';

  function handleSeed() {
    setSeedState(null);
    startSeed(async () => {
      const result = await seedDefaultsForCurrentWorkspace();
      setSeedState(result);
    });
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'updatedAt' ? 'desc' : 'asc');
    }
  }

  function resetFilters() {
    setSearch('');
    setKindFilter('all');
    setTargetFilter('all');
    setTriggerFilter('all');
    setStatusFilter('all');
    setPage(1);
  }

  return (
    <div className="px-6 py-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Actions</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Configurable AI actions that operate on issues and PRs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSeed}
            disabled={seeding || readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshIcon className="h-4 w-4" />
            {seeding ? 'Syncing…' : 'Sync from defaults'}
          </button>
          <Link
            href="/actions/new"
            aria-disabled={readOnly}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
              readOnly && 'pointer-events-none opacity-50',
            )}
          >
            <PlusIcon className="h-4 w-4" />
            New action
          </Link>
        </div>
      </header>

      {seedState?.ok && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary-container/20 px-4 py-2 text-sm text-primary">
          Synced defaults. Any missing built-in actions were restored.
        </div>
      )}
      {seedState?.error && (
        <div className="mb-4 rounded-md border border-error/30 bg-error-container/30 px-4 py-2 text-sm text-error">
          {seedState.error}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="TOTAL ACTIONS" value={String(totalActions)} tone="default" />
        <StatCard label="ENABLED" value={String(enabledCount)} tone="primary" />
        <StatCard label="BUILT-IN" value={String(builtinCount)} tone="tertiary" />
        <StatCard label="USER" value={String(userCount)} tone="default" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <label className="relative flex min-w-[220px] flex-1 items-center">
          <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name, description, or trigger…"
            className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>

        <FilterSelect
          label="Target"
          value={targetFilter}
          onChange={(v) => {
            setTargetFilter(v as TargetFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All targets' },
            { value: 'issue', label: 'Issue' },
            { value: 'pr', label: 'PR' },
          ]}
        />
        <FilterSelect
          label="Kind"
          value={kindFilter}
          onChange={(v) => {
            setKindFilter(v as KindFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All kinds' },
            { value: 'built-in', label: 'Built-in' },
            { value: 'user', label: 'User' },
          ]}
        />
        <FilterSelect
          label="Trigger"
          value={triggerFilter}
          onChange={(v) => {
            setTriggerFilter(v as TriggerFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All triggers' },
            ...distinctTriggers.map((t) => ({ value: t, label: t })),
          ]}
        />
        <FilterSelect
          label="Status"
          value={statusFilter}
          onChange={(v) => {
            setStatusFilter(v as StatusFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'enabled', label: 'Enabled' },
            { value: 'disabled', label: 'Disabled' },
          ]}
        />

        {filtersActive && (
          <button
            type="button"
            onClick={resetFilters}
            className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-surface-container">
                <SortableTh sortKey="name"      sortDir={sortDir} active={sortKey === 'name'}      onClick={handleSort}>NAME</SortableTh>
                <SortableTh sortKey="kind"      sortDir={sortDir} active={sortKey === 'kind'}      onClick={handleSort}>KIND</SortableTh>
                <SortableTh sortKey="target"    sortDir={sortDir} active={sortKey === 'target'}    onClick={handleSort}>TARGET</SortableTh>
                <SortableTh sortKey="triggers"  sortDir={sortDir} active={sortKey === 'triggers'}  onClick={handleSort}>TRIGGERS</SortableTh>
                <SortableTh sortKey="effects"   sortDir={sortDir} active={sortKey === 'effects'}   onClick={handleSort}>EFFECTS</SortableTh>
                <SortableTh sortKey="status"    sortDir={sortDir} active={sortKey === 'status'}    onClick={handleSort}>STATUS</SortableTh>
                <SortableTh sortKey="updatedAt" sortDir={sortDir} active={sortKey === 'updatedAt'} onClick={handleSort}>LAST UPDATED</SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-on-surface-variant">
                    {totalActions === 0 ? (
                      <>
                        No actions in this workspace yet.{' '}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={handleSeed}
                            className="underline underline-offset-2 hover:text-on-surface"
                          >
                            Sync defaults
                          </button>
                        )}{' '}
                        to seed the built-in catalog.
                      </>
                    ) : (
                      <>
                        No actions match these filters.{' '}
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="underline underline-offset-2 hover:text-on-surface"
                        >
                          Clear filters
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => (
                  <ActionTableRow
                    key={row.name}
                    row={row}
                    isAutoTriage={row.id === autoTriageActionId}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-4 text-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
              {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of {totalFiltered}
              {filtersActive && <> filtered (of {totalActions})</>} action{totalFiltered === 1 ? '' : 's'}
            </span>
            <span className="hidden h-4 w-px bg-outline-variant sm:inline-block" aria-hidden />
            <label className="flex items-center gap-2">
              <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
                Per page
              </span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value) as PageSize);
                  setPage(1);
                }}
                className="h-8 rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          )}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <CalloutCard
          tone="tertiary"
          title="Built-in actions"
          body={
            <>
              These ship with Cezar and apply to every workspace by default. Override by editing — your edits
              become a new <span className="font-medium text-on-surface">user</span> action with the same name.
            </>
          }
        />
        <CalloutCard
          tone="primary"
          title="Auto-triage"
          body={
            <>
              Your workspace&apos;s auto-triage action runs once per new issue/PR. Set or change it from the
              action&apos;s detail page, or pick from the list at{' '}
              <Link href="/settings" className="text-primary hover:underline">/settings</Link>.
            </>
          }
        />
      </div>
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-6 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant',
        className,
      )}
    >
      {children}
    </th>
  );
}

function SortableTh({
  children,
  sortKey,
  active,
  sortDir,
  onClick,
  className,
}: {
  children: React.ReactNode;
  sortKey: SortKey;
  active: boolean;
  sortDir: SortDir;
  onClick: (key: SortKey) => void;
  className?: string;
}) {
  return (
    <th
      className={cn(
        'whitespace-nowrap px-6 py-3 text-left font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant',
        className,
      )}
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-on-surface',
          active && 'text-on-surface',
        )}
      >
        <span>{children}</span>
        <SortIndicator active={active} dir={sortDir} />
      </button>
    </th>
  );
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex flex-col text-[8px] leading-[8px]', active ? 'text-primary' : 'text-outline-variant')}
    >
      <span className={cn(active && dir === 'asc' ? 'text-primary' : 'text-outline-variant')}>▲</span>
      <span className={cn(active && dir === 'desc' ? 'text-primary' : 'text-outline-variant')}>▼</span>
    </span>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-9 min-w-[7.5rem] rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function compareByKey(a: ActionRow, b: ActionRow, key: SortKey): number {
  if (key === 'updatedAt') {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : -Infinity;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : -Infinity;
    if (ta === tb) return a.name.localeCompare(b.name);
    return ta - tb;
  }
  if (key === 'triggers') {
    return a.triggers.length - b.triggers.length || a.name.localeCompare(b.name);
  }
  if (key === 'effects') {
    const ea = a.effectsDeclared ?? -1;
    const eb = b.effectsDeclared ?? -1;
    return ea - eb || a.name.localeCompare(b.name);
  }
  const av = String(a[key as keyof ActionRow] ?? '');
  const bv = String(b[key as keyof ActionRow] ?? '');
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return cmp === 0 ? a.name.localeCompare(b.name) : cmp;
}

function ActionTableRow({ row, isAutoTriage }: { row: ActionRow; isAutoTriage: boolean }) {
  const href = `/actions/${encodeURIComponent(row.name)}`;
  return (
    <tr className="border-t border-outline-variant/60 hover:bg-surface-container/60">
      <td className="px-6 py-4 align-middle">
        <Link href={href} className="flex items-center gap-2 text-on-surface hover:text-primary">
          {row.hasBuiltinShadow && <span className="text-tertiary" aria-hidden>*</span>}
          <span className="font-medium">{row.name}</span>
          {isAutoTriage && (
            <span className="ml-1 inline-flex items-center rounded-md border border-primary/40 bg-primary-container/20 px-1.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.05em] text-primary">
              Auto-triage
            </span>
          )}
        </Link>
        {row.description && (
          <div className="mt-1 max-w-[420px] truncate text-xs text-on-surface-variant">{row.description}</div>
        )}
      </td>
      <td className="px-6 py-4 align-middle">
        <KindBadge kind={row.kind} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.target}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <TriggersChips triggers={row.triggers} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">
          {row.effectsDeclared === null ? 'agent tools' : `${row.effectsDeclared} declared`}
        </span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="inline-flex items-center gap-2 text-on-surface">
          <StatusDotIcon className="h-2.5 w-2.5" tone={row.status === 'enabled' ? 'enabled' : 'disabled'} />
          <span className="font-mono text-[13px]">{row.status}</span>
        </span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{formatRelative(row.updatedAt)}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <div className="flex items-center justify-end pr-2">
          <button
            type="button"
            aria-label={`${row.name} actions`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          >
            <MoreVerticalIcon className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function KindBadge({ kind }: { kind: ActionRow['kind'] }) {
  const classes =
    kind === 'user'
      ? 'border-primary/40 bg-primary-container/30 text-primary'
      : 'border-tertiary-container/60 bg-tertiary-container/30 text-tertiary';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[11px] font-semibold uppercase tracking-[0.05em]',
        classes,
      )}
    >
      {kind === 'built-in' ? 'BUILT-IN' : 'USER'}
    </span>
  );
}

function TriggersChips({ triggers }: { triggers: string[] }) {
  if (triggers.length === 0) {
    return <span className="font-mono text-[13px] text-on-surface-variant">—</span>;
  }
  const visible = triggers.slice(0, 2);
  const extra = triggers.length - visible.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {visible.map((t) => (
        <span
          key={t}
          className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant"
        >
          {t}
        </span>
      ))}
      {extra > 0 && (
        <span className="font-mono text-[11px] text-on-surface-variant">+{extra}</span>
      )}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'default' | 'primary' | 'tertiary';
}) {
  const valueColor =
    tone === 'primary' ? 'text-primary' : tone === 'tertiary' ? 'text-tertiary' : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </div>
      <div className={cn('mt-2 text-[28px] font-semibold leading-none tracking-tight', valueColor)}>{value}</div>
    </div>
  );
}

function CalloutCard({ title, body, tone }: { title: string; body: React.ReactNode; tone: 'primary' | 'tertiary' }) {
  const rail = tone === 'primary' ? 'bg-primary' : 'bg-tertiary';
  return (
    <div className="relative overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low p-5 pl-6">
      <span className={cn('absolute inset-y-3 left-0 w-1 rounded-full', rail)} aria-hidden />
      <div className="text-sm font-semibold text-on-surface">{title}</div>
      <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">{body}</p>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  return (
    <div className="flex items-center gap-1">
      <PagerButton onClick={() => onChange(Math.max(1, page - 1))} disabled={page === 1} aria-label="Previous page">
        <ChevronLeftIcon className="h-4 w-4" />
      </PagerButton>
      {pages.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            'h-8 min-w-[2rem] rounded-md border px-2 text-sm transition-colors',
            p === page
              ? 'border-primary/40 bg-surface-container text-on-surface'
              : 'border-outline-variant bg-surface-container-low text-on-surface-variant hover:border-primary hover:text-on-surface',
          )}
        >
          {p}
        </button>
      ))}
      <PagerButton onClick={() => onChange(Math.min(totalPages, page + 1))} disabled={page === totalPages} aria-label="Next page">
        <ChevronRightIcon className="h-4 w-4" />
      </PagerButton>
    </div>
  );
}

function PagerButton({
  onClick,
  disabled,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-outline-variant bg-surface-container-low text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
