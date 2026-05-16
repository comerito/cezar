'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { SearchIcon, BellIcon, SparkleSmallIcon, TerminalIcon } from './icons';
import { cn } from './ui/cn';
import { searchWorkspace, type SearchResult } from './topbar-actions';

interface TopBarProps {
  user: { id: string; email: string; name: string; avatarUrl: string };
  searchPlaceholder?: string;
}

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

export function TopBar({ user, searchPlaceholder = 'Search skills, documentation, or status…' }: TopBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initials = useMemo(
    () =>
      (user.name || user.email || '?')
        .split(/\s+/)
        .map((p) => p[0])
        .filter(Boolean)
        .slice(0, 2)
        .join('')
        .toUpperCase(),
    [user.name, user.email],
  );

  // Debounced search.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      setResults([]);
      return;
    }
    timerRef.current = setTimeout(() => {
      startTransition(async () => {
        const r = await searchWorkspace(trimmed);
        setResults(r);
      });
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  // Close the dropdown when the user clicks outside.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const showDropdown = open && query.trim().length >= MIN_QUERY;

  return (
    <header className="sticky top-0 z-10 flex h-topbar items-center gap-4 border-b border-outline-variant bg-surface px-6 backdrop-blur">
      <div ref={containerRef} className="relative flex-1 max-w-3xl">
        <label className="relative flex items-center">
          <SearchIcon className="absolute left-3 h-4 w-4 text-on-surface-variant" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={searchPlaceholder}
            className="h-9 w-full rounded-md border border-outline-variant bg-surface-container-low pl-9 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:shadow-focus-primary focus:outline-none"
          />
        </label>

        {showDropdown && (
          <SearchDropdown
            results={results}
            query={query}
            pending={pending}
            onSelect={() => {
              setOpen(false);
              setQuery('');
            }}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface"
          aria-label="Notifications"
        >
          <BellIcon className="h-5 w-5" />
        </button>

        <div className="mx-2 h-6 w-px bg-outline-variant" aria-hidden />

        <div className="flex items-center gap-2 pr-1">
          <div className="text-sm font-medium text-on-surface">{user.name || 'Cezar'}</div>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-md object-cover" />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-container text-xs font-semibold text-primary-on-container">
              {initials || 'CZ'}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function SearchDropdown({
  results,
  query,
  pending,
  onSelect,
}: {
  results: SearchResult[];
  query: string;
  pending: boolean;
  onSelect: () => void;
}) {
  const skills = results.filter((r): r is Extract<SearchResult, { kind: 'skill' }> => r.kind === 'skill');
  const runs = results.filter((r): r is Extract<SearchResult, { kind: 'run' }> => r.kind === 'run');
  const empty = !pending && results.length === 0;

  return (
    <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-md border border-outline-variant bg-surface-container shadow-ambient">
      {pending && results.length === 0 && (
        <div className="px-4 py-3 text-xs text-on-surface-variant">Searching…</div>
      )}
      {empty && (
        <div className="px-4 py-3 text-xs text-on-surface-variant">
          No matches for <span className="font-mono text-on-surface">{query}</span>.
        </div>
      )}
      {skills.length > 0 && (
        <Section title="Skills">
          {skills.map((s) => (
            <Link
              key={`skill:${s.name}`}
              href={`/skills/${encodeURIComponent(s.name)}`}
              onClick={onSelect}
              className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-container-high"
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <SparkleSmallIcon
                  className={cn('h-4 w-4 shrink-0', s.isOverride ? 'text-primary' : 'text-on-surface-variant')}
                />
                <span className="min-w-0 truncate text-sm text-on-surface">{s.name}</span>
                {s.description && (
                  <span className="hidden truncate text-xs text-on-surface-variant md:inline">
                    — {s.description}
                  </span>
                )}
              </span>
              {s.isOverride && (
                <span className="shrink-0 rounded-md border border-primary/40 bg-primary-container/20 px-1.5 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.05em] text-primary">
                  Override
                </span>
              )}
            </Link>
          ))}
        </Section>
      )}
      {runs.length > 0 && (
        <Section title="Recent Runs">
          {runs.map((r) => (
            <Link
              key={`run:${r.id}`}
              href={`/cockpit/${r.id}`}
              onClick={onSelect}
              className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-container-high"
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                <TerminalIcon className="h-4 w-4 shrink-0 text-on-surface-variant" />
                <span className="min-w-0 truncate text-sm text-on-surface">
                  {r.workflow}
                  {r.issueNumber !== null && <span className="ml-1 text-on-surface-variant">#{r.issueNumber}</span>}
                </span>
              </span>
              <span className="shrink-0 rounded-md border border-outline-variant bg-surface px-1.5 py-0.5 font-mono text-[11px] text-on-surface-variant">
                {r.status}
              </span>
            </Link>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="border-b border-outline-variant bg-surface-container-low px-4 py-1.5 font-display text-[10px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}
