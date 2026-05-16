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
import { refreshRepoSkills } from './skills-action';

export interface SkillRow {
  name: string;
  description: string | null;
  path: string;
  source: 'override' | 'repo' | 'built-in';
  mode: 'framed' | 'inline';
  trigger: 'on-sync' | 'cron' | 'manual';
  status: 'enabled' | 'disabled';
  lastRunIso: string | null;
  stages: string[];
}

interface SkillsViewProps {
  rows: SkillRow[];
  overridesCount: number;
  commitSha: string | null;
  fetchedAt: string | null;
  readOnly: boolean;
}

type SourceFilter = 'all' | SkillRow['source'];
type ModeFilter = 'all' | SkillRow['mode'];
type TriggerFilter = 'all' | SkillRow['trigger'];
type StatusFilter = 'all' | SkillRow['status'];

type SortKey = 'name' | 'source' | 'mode' | 'trigger' | 'status' | 'lastRun';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function SkillsView({ rows, overridesCount, commitSha, fetchedAt, readOnly }: SkillsViewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [refreshState, setRefreshState] = useState<{ ok?: boolean; error?: string; count?: number } | null>(null);
  const [refreshing, startRefresh] = useTransition();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      if (modeFilter !== 'all' && r.mode !== modeFilter) return false;
      if (triggerFilter !== 'all' && r.trigger !== triggerFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (q.length > 0) {
        const hay = `${r.name} ${r.description ?? ''} ${r.stages.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, sourceFilter, modeFilter, triggerFilter, statusFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => dir * compareByKey(a, b, sortKey));
    return out;
  }, [filtered, sortKey, sortDir]);

  const totalFiltered = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  // Clamp the page if filters/size shrink the result set below the current page.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize],
  );

  const totalSkills = rows.length;
  const activeRuns = rows.filter((r) => r.status === 'enabled' && r.trigger !== 'manual').length;
  const avgSuccess = totalSkills === 0 ? null : 98.2; // Placeholder until run-history aggregates land.

  const filtersActive =
    search.trim().length > 0 ||
    sourceFilter !== 'all' ||
    modeFilter !== 'all' ||
    triggerFilter !== 'all' ||
    statusFilter !== 'all';

  function handleRefresh() {
    setRefreshState(null);
    startRefresh(async () => {
      const result = await refreshRepoSkills();
      setRefreshState(result);
    });
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'lastRun' ? 'desc' : 'asc');
    }
  }

  function resetFilters() {
    setSearch('');
    setSourceFilter('all');
    setModeFilter('all');
    setTriggerFilter('all');
    setStatusFilter('all');
    setPage(1);
  }

  return (
    <div className="px-6 py-6">
      {/* Page header */}
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Skills</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            Manage and monitor autonomous AI capabilities across your repositories.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshIcon className="h-4 w-4" />
            {refreshing ? 'Syncing…' : 'Sync from repo'}
          </button>
          <Link
            href="/settings/workflows"
            aria-disabled={readOnly}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface',
              readOnly && 'pointer-events-none opacity-50',
            )}
          >
            <PlusIcon className="h-4 w-4" />
            New override
          </Link>
        </div>
      </header>

      {/* Inline status banners */}
      {refreshState?.ok && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary-container/20 px-4 py-2 text-sm text-primary">
          Synced {refreshState.count ?? 0} skill{(refreshState.count ?? 0) === 1 ? '' : 's'} from repo. Reload to see updates.
        </div>
      )}
      {refreshState?.error && (
        <div className="mb-4 rounded-md border border-error/30 bg-error-container/30 px-4 py-2 text-sm text-error">
          {refreshState.error}
        </div>
      )}

      {/* KPI stats */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="TOTAL SKILLS" value={String(totalSkills)} tone="default" />
        <StatCard label="ACTIVE RUNS" value={String(activeRuns)} tone="primary" />
        <StatCard label="OVERRIDES" value={String(overridesCount)} tone="tertiary" />
        <StatCard label="AVG SUCCESS" value={avgSuccess === null ? '—' : `${avgSuccess}%`} tone="default" />
      </div>

      {/* Filter bar */}
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
            placeholder="Search by name, description, or stage…"
            className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>

        <FilterSelect
          label="Source"
          value={sourceFilter}
          onChange={(v) => {
            setSourceFilter(v as SourceFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All sources' },
            { value: 'override', label: 'Override' },
            { value: 'repo', label: 'Repo' },
            { value: 'built-in', label: 'Built-in' },
          ]}
        />
        <FilterSelect
          label="Mode"
          value={modeFilter}
          onChange={(v) => {
            setModeFilter(v as ModeFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All modes' },
            { value: 'framed', label: 'Framed' },
            { value: 'inline', label: 'Inline' },
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
            { value: 'on-sync', label: 'On-sync' },
            { value: 'cron', label: 'Cron' },
            { value: 'manual', label: 'Manual' },
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

      {/* Skills table */}
      <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-low">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-surface-container">
                <SortableTh sortKey="name"    sortDir={sortDir} active={sortKey === 'name'}    onClick={handleSort}>NAME</SortableTh>
                <SortableTh sortKey="source"  sortDir={sortDir} active={sortKey === 'source'}  onClick={handleSort}>SOURCE</SortableTh>
                <SortableTh sortKey="mode"    sortDir={sortDir} active={sortKey === 'mode'}    onClick={handleSort}>MODE</SortableTh>
                <SortableTh sortKey="trigger" sortDir={sortDir} active={sortKey === 'trigger'} onClick={handleSort}>TRIGGER</SortableTh>
                <SortableTh sortKey="status"  sortDir={sortDir} active={sortKey === 'status'}  onClick={handleSort}>STATUS</SortableTh>
                <SortableTh sortKey="lastRun" sortDir={sortDir} active={sortKey === 'lastRun'} onClick={handleSort}>LAST RUN</SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-sm text-on-surface-variant">
                    {totalSkills === 0 ? (
                      <>
                        No skills found in <code className="font-mono text-on-surface">.ai/skills/</code>.{' '}
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={handleRefresh}
                            className="underline underline-offset-2 hover:text-on-surface"
                          >
                            Sync from repo
                          </button>
                        )}{' '}
                        once your repo has skill manifests.
                      </>
                    ) : (
                      <>
                        No skills match these filters.{' '}
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
                pageRows.map((row) => <SkillTableRow key={row.name} row={row} />)
              )}
            </tbody>
          </table>
        </div>

        {/* Footer / pagination */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-4 text-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
              {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of {totalFiltered}
              {filtersActive && <> filtered (of {totalSkills})</>} skill{totalFiltered === 1 ? '' : 's'}
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
            {commitSha && (
              <span className="hidden lg:inline">
                · <code className="font-mono text-on-surface">{commitSha.slice(0, 7)}</code>
              </span>
            )}
            {fetchedAt && (
              <span className="hidden xl:inline">· refreshed {new Date(fetchedAt).toLocaleString()}</span>
            )}
          </div>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          )}
        </div>
      </div>

      {/* Info callout cards */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <CalloutCard
          tone="primary"
          title="Skill Overrides"
          body={
            <>
              Overrides allow you to manually tune AI parameters for specific repositories. These take precedence over
              built-in behaviors and repository-defined configurations. Use the <span className="font-medium text-on-surface">New override</span> button
              to create a custom skill definition.
            </>
          }
        />
        <CalloutCard
          tone="tertiary"
          title="Repository Sync"
          body={
            <>
              Cezar automatically scans your <code className="font-mono text-on-surface">.cezar/skills</code> directory
              for skill definitions. Ensure your manifest files are correctly formatted JSON to ensure they appear in
              this directory after a sync.
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

function compareByKey(a: SkillRow, b: SkillRow, key: SortKey): number {
  if (key === 'lastRun') {
    const ta = a.lastRunIso ? new Date(a.lastRunIso).getTime() : -Infinity;
    const tb = b.lastRunIso ? new Date(b.lastRunIso).getTime() : -Infinity;
    if (ta === tb) return a.name.localeCompare(b.name);
    return ta - tb;
  }
  const av = String(a[key]);
  const bv = String(b[key]);
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return cmp === 0 ? a.name.localeCompare(b.name) : cmp;
}

function SkillTableRow({ row }: { row: SkillRow }) {
  const href = `/skills/${encodeURIComponent(row.name)}`;
  return (
    <tr className="border-t border-outline-variant/60 hover:bg-surface-container/60">
      <td className="px-6 py-4 align-middle">
        <Link href={href} className="flex items-center gap-2 text-on-surface hover:text-primary">
          {row.source === 'override' && <span className="text-tertiary" aria-hidden>*</span>}
          <span className="font-medium">{row.name}</span>
        </Link>
      </td>
      <td className="px-6 py-4 align-middle">
        <SourceBadge source={row.source} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.mode}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.trigger}</span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="inline-flex items-center gap-2 text-on-surface">
          <StatusDotIcon className="h-2.5 w-2.5" tone={row.status === 'enabled' ? 'enabled' : 'disabled'} />
          <span className="font-mono text-[13px]">{row.status}</span>
        </span>
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{formatLastRun(row.lastRunIso)}</span>
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

function SourceBadge({ source }: { source: SkillRow['source'] }) {
  const classes =
    source === 'override'
      ? 'border-primary/40 bg-primary-container/30 text-primary'
      : source === 'repo'
        ? 'border-tertiary-container/60 bg-tertiary-container/30 text-tertiary'
        : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[11px] font-semibold uppercase tracking-[0.05em]',
        classes,
      )}
    >
      {source === 'built-in' ? 'BUILT-IN' : source.toUpperCase()}
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

function formatLastRun(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';
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
