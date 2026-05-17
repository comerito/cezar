'use client';

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/components/ui/cn';
import {
  SearchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@/components/icons';
import { RunStatusDots } from '@/components/run-status-dots';
import type { ActionRunSummary, RunStatus } from '@/lib/action-runs-loader';
import { IssueRowMenu } from './issue-row-menu';

export interface IssueRow {
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  priority: 'critical' | 'high' | 'medium' | 'low' | null;
  issueType: 'bug' | 'feature' | 'question' | 'other' | null;
  labels: string[];
  commentCount: number;
  /** Most-recent agent_runs against this issue, newest first, capped at 5
   *  by the loader. Each one renders as a dot in the status column. */
  actionRuns: ActionRunSummary[];
  /** Backing store status — disables the autofix kebab item when 'pr-opened'. */
  autofixStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'pr-opened' | null;
}

interface IssuesViewProps {
  rows: IssueRow[];
  repoLabel: string;
  fetchedAt: string | null;
  readOnly: boolean;
}

type StateFilter = 'all' | 'open' | 'closed';
type PriorityFilter = 'all' | NonNullable<IssueRow['priority']> | 'unset';
type TypeFilter = 'all' | NonNullable<IssueRow['issueType']> | 'unset';
type RunStatusFilter = 'all' | 'has-runs' | 'running' | 'enqueued' | 'succeeded' | 'failed' | 'none';

type SortKey = 'runStatus' | 'number' | 'title' | 'state' | 'priority' | 'comments';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

const PRIORITY_RANK: Record<NonNullable<IssueRow['priority']>, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

// Higher = more "attention needed", used for the status column sort.
// Picks the most-attention-needed status across the row's action runs.
const RUN_STATUS_RANK: Record<RunStatus | 'none', number> = {
  running: 5,
  queued: 4,
  failed: 3,
  paused: 2,
  succeeded: 1,
  skipped: 0,
  none: 0,
};

/** Returns the worst-case status across all of the row's runs — drives both
 *  the legacy filter options and sort ranking. 'none' for empty. */
function topStatus(runs: ActionRunSummary[]): RunStatus | 'none' {
  if (runs.length === 0) return 'none';
  let best: RunStatus = runs[0].status;
  let bestRank = RUN_STATUS_RANK[best];
  for (const r of runs) {
    const rank = RUN_STATUS_RANK[r.status];
    if (rank > bestRank) {
      best = r.status;
      bestRank = rank;
    }
  }
  return best;
}

export function IssuesView({ rows, repoLabel, fetchedAt, readOnly }: IssuesViewProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [runStatusFilter, setRunStatusFilter] = useState<RunStatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('number');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (stateFilter !== 'all' && r.state !== stateFilter) return false;
      if (priorityFilter !== 'all') {
        if (priorityFilter === 'unset' ? r.priority !== null : r.priority !== priorityFilter) return false;
      }
      if (typeFilter !== 'all') {
        if (typeFilter === 'unset' ? r.issueType !== null : r.issueType !== typeFilter) return false;
      }
      if (runStatusFilter !== 'all') {
        const top = topStatus(r.actionRuns);
        if (runStatusFilter === 'has-runs') {
          if (r.actionRuns.length === 0) return false;
        } else if (runStatusFilter === 'enqueued') {
          if (top !== 'queued') return false;
        } else if (runStatusFilter === 'none') {
          if (r.actionRuns.length > 0) return false;
        } else if (top !== runStatusFilter) {
          return false;
        }
      }
      if (q.length > 0) {
        const hay = `${r.number} ${r.title} ${r.labels.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, stateFilter, priorityFilter, typeFilter, runStatusFilter]);

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

  const totalIssues = rows.length;
  const openCount = rows.filter((r) => r.state === 'open').length;
  const bugCount = rows.filter((r) => r.issueType === 'bug').length;
  const runningCount = rows.filter((r) =>
    r.actionRuns.some((run) => run.status === 'running' || run.status === 'queued'),
  ).length;

  const filtersActive =
    search.trim().length > 0 ||
    stateFilter !== 'all' ||
    priorityFilter !== 'all' ||
    typeFilter !== 'all' ||
    runStatusFilter !== 'all';

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'number' || key === 'comments' || key === 'priority' || key === 'runStatus' ? 'desc' : 'asc');
    }
  }

  function resetFilters() {
    setSearch('');
    setStateFilter('all');
    setPriorityFilter('all');
    setTypeFilter('all');
    setRunStatusFilter('all');
    setPage(1);
  }

  return (
    <div className="px-6 py-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold leading-tight tracking-tight text-on-surface">Issues</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            <span className="font-mono">{repoLabel}</span> — {totalIssues} issue{totalIssues === 1 ? '' : 's'} synced
          </p>
        </div>
      </header>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="TOTAL ISSUES" value={String(totalIssues)} tone="default" />
        <StatCard label="OPEN" value={String(openCount)} tone="primary" />
        <StatCard label="BUGS" value={String(bugCount)} tone="tertiary" />
        <StatCard
          label="RUNNING"
          value={String(runningCount)}
          tone="default"
          pulse={runningCount > 0}
        />
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
            placeholder="Search by title, label, or number…"
            className="h-9 w-full rounded-md border border-outline-variant bg-surface pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>

        <FilterSelect
          label="State"
          value={stateFilter}
          onChange={(v) => {
            setStateFilter(v as StateFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All states' },
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
        <FilterSelect
          label="Priority"
          value={priorityFilter}
          onChange={(v) => {
            setPriorityFilter(v as PriorityFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All priorities' },
            { value: 'critical', label: 'Critical' },
            { value: 'high', label: 'High' },
            { value: 'medium', label: 'Medium' },
            { value: 'low', label: 'Low' },
            { value: 'unset', label: 'Unset' },
          ]}
        />
        <FilterSelect
          label="Type"
          value={typeFilter}
          onChange={(v) => {
            setTypeFilter(v as TypeFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All types' },
            { value: 'bug', label: 'Bug' },
            { value: 'feature', label: 'Feature' },
            { value: 'question', label: 'Question' },
            { value: 'other', label: 'Other' },
            { value: 'unset', label: 'Unset' },
          ]}
        />
        <FilterSelect
          label="Run status"
          value={runStatusFilter}
          onChange={(v) => {
            setRunStatusFilter(v as RunStatusFilter);
            setPage(1);
          }}
          options={[
            { value: 'all', label: 'All' },
            { value: 'has-runs', label: 'Has any run' },
            { value: 'running', label: 'Running' },
            { value: 'enqueued', label: 'Enqueued' },
            { value: 'succeeded', label: 'Succeeded' },
            { value: 'failed', label: 'Failed' },
            { value: 'none', label: 'No runs' },
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
                <SortableTh sortKey="runStatus" sortDir={sortDir} active={sortKey === 'runStatus'} onClick={handleSort} className="w-[44px] pr-2">
                  <span className="sr-only">Run status</span>
                </SortableTh>
                <SortableTh sortKey="number"   sortDir={sortDir} active={sortKey === 'number'}   onClick={handleSort}>#</SortableTh>
                <SortableTh sortKey="title"    sortDir={sortDir} active={sortKey === 'title'}    onClick={handleSort}>NAME</SortableTh>
                <SortableTh sortKey="state"    sortDir={sortDir} active={sortKey === 'state'}    onClick={handleSort}>STATE</SortableTh>
                <SortableTh sortKey="priority" sortDir={sortDir} active={sortKey === 'priority'} onClick={handleSort}>PRIORITY</SortableTh>
                <Th>LABELS</Th>
                <SortableTh sortKey="comments" sortDir={sortDir} active={sortKey === 'comments'} onClick={handleSort}>COMMENTS</SortableTh>
                <Th className="text-right pr-6">ACTIONS</Th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-sm text-on-surface-variant">
                    {totalIssues === 0 ? (
                      <>No issues in this workspace yet. Sync to pull them in from GitHub.</>
                    ) : (
                      <>
                        No issues match these filters.{' '}
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
                pageRows.map((row) => <IssueTableRow key={row.number} row={row} readOnly={readOnly} />)
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-4 text-sm text-on-surface-variant">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              Showing {pageRows.length === 0 ? 0 : (page - 1) * pageSize + 1}
              {pageRows.length > 0 && <>–{(page - 1) * pageSize + pageRows.length}</>} of {totalFiltered}
              {filtersActive && <> filtered (of {totalIssues})</>} issue{totalFiltered === 1 ? '' : 's'}
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
            {fetchedAt && (
              <span className="hidden lg:inline">· refreshed {new Date(fetchedAt).toLocaleString()}</span>
            )}
          </div>
          {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}
        </div>
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

function compareByKey(a: IssueRow, b: IssueRow, key: SortKey): number {
  if (key === 'number' || key === 'comments') {
    const av = key === 'number' ? a.number : a.commentCount;
    const bv = key === 'number' ? b.number : b.commentCount;
    return av - bv || a.number - b.number;
  }
  if (key === 'priority') {
    const av = a.priority ? PRIORITY_RANK[a.priority] : 0;
    const bv = b.priority ? PRIORITY_RANK[b.priority] : 0;
    return av - bv || a.number - b.number;
  }
  if (key === 'runStatus') {
    return RUN_STATUS_RANK[topStatus(a.actionRuns)] - RUN_STATUS_RANK[topStatus(b.actionRuns)]
      || a.number - b.number;
  }
  const av = String(a[key as 'title' | 'state']);
  const bv = String(b[key as 'title' | 'state']);
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return cmp === 0 ? a.number - b.number : cmp;
}

function IssueTableRow({ row, readOnly }: { row: IssueRow; readOnly: boolean }) {
  const hasInflight = row.actionRuns.some(
    (r) => r.status === 'running' || r.status === 'queued',
  );
  const autofixDisabled =
    row.state === 'closed' || row.autofixStatus === 'pr-opened' || hasInflight;
  return (
    <tr className="border-t border-outline-variant/60 hover:bg-surface-container/60">
      <td className="px-4 py-4 align-middle">
        <RunStatusDots runs={row.actionRuns} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">#{row.number}</span>
      </td>
      <td className="max-w-[440px] px-6 py-4 align-middle">
        <a
          href={row.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-medium text-on-surface hover:text-primary"
          title={row.title}
        >
          {row.title}
        </a>
      </td>
      <td className="px-6 py-4 align-middle">
        <span
          className={cn(
            'font-mono text-[13px]',
            row.state === 'open' ? 'text-primary' : 'text-on-surface-variant',
          )}
        >
          {row.state}
        </span>
      </td>
      <td className="px-6 py-4 align-middle">
        <PriorityBadge priority={row.priority} />
      </td>
      <td className="max-w-[220px] px-6 py-4 align-middle">
        <LabelChips labels={row.labels} />
      </td>
      <td className="px-6 py-4 align-middle">
        <span className="font-mono text-[13px] text-on-surface-variant">{row.commentCount}</span>
      </td>
      <td className="relative px-6 py-4 align-middle">
        <div className="flex items-center justify-end pr-2">
          <IssueRowMenu
            issueNumber={row.number}
            issueTitle={row.title}
            issueUrl={row.htmlUrl}
            autofixDisabled={autofixDisabled}
            readOnly={readOnly}
          />
        </div>
      </td>
    </tr>
  );
}

function PriorityBadge({ priority }: { priority: IssueRow['priority'] }) {
  if (!priority) {
    return <span className="font-mono text-[13px] text-on-surface-variant">—</span>;
  }
  const classes =
    priority === 'critical'
      ? 'border-error/40 bg-error-container/40 text-error'
      : priority === 'high'
        ? 'border-error/30 bg-error-container/20 text-error'
        : priority === 'medium'
          ? 'border-tertiary-container/60 bg-tertiary-container/30 text-tertiary'
          : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[11px] font-semibold uppercase tracking-[0.05em]',
        classes,
      )}
    >
      {priority}
    </span>
  );
}

function LabelChips({ labels }: { labels: string[] }) {
  if (labels.length === 0) {
    return <span className="font-mono text-[13px] text-on-surface-variant">—</span>;
  }
  const visible = labels.slice(0, 3);
  const extra = labels.length - visible.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {visible.map((l) => (
        <span
          key={l}
          className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant"
          title={l}
        >
          {l}
        </span>
      ))}
      {extra > 0 && <span className="font-mono text-[11px] text-on-surface-variant">+{extra}</span>}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
  pulse,
}: {
  label: string;
  value: string;
  tone: 'default' | 'primary' | 'tertiary';
  pulse?: boolean;
}) {
  const valueColor =
    tone === 'primary' ? 'text-primary' : tone === 'tertiary' ? 'text-tertiary' : 'text-on-surface';
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-4">
      <div className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {label}
      </div>
      <div
        className={cn(
          'mt-2 text-[28px] font-semibold leading-none tracking-tight',
          valueColor,
          pulse && 'animate-pulse',
        )}
      >
        {value}
      </div>
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
