// In-process scheduler for self-hosted Node deployments — drives every cron
// route on `setInterval` from inside the Next.js server process.
//
// Booted by `src/instrumentation.ts` when `CEZAR_INPROCESS_CRON=true` and the
// runtime is `nodejs`. Idempotent via a `globalThis` flag so dev-mode HMR
// reloads don't spawn duplicate timers. In multi-replica deployments every
// replica ticks — that's safe (the cron handlers all dedupe / atomically claim)
// just wasteful.
//
// Implementation note: this driver `fetch`es the local cron routes rather than
// importing their handler modules. That keeps `@cezar/core` (and its
// `cosmiconfig` → Node-builtins transitive deps) out of the bundle Next.js
// generates for the Edge-runtime build of `instrumentation.ts`. The cron
// routes themselves run on the Node runtime, so the actual work happens in
// the same process — the `fetch` is a localhost round-trip.
//
// Vercel deployments should keep using the `vercel.json` cron schedules and
// leave `CEZAR_INPROCESS_CRON` unset.

const FLAG = Symbol.for('cezar.inProcessScheduler.started');

interface CronJob {
  /** e.g. '/api/cron/dispatch' */
  path: string;
  /** tick interval in ms; default keyed to the `vercel.json` schedule */
  defaultIntervalMs: number;
  /** env var that overrides `defaultIntervalMs` */
  envOverride: string;
  /** custom log formatter for the JSON body returned by the route — return null to stay silent on this tick */
  formatLog?: (body: unknown) => string | null;
}

// Defaults mirror `packages/gui/vercel.json` cadences.
const JOBS: CronJob[] = [
  // — Phase 3+ (new) crons —
  {
    path: '/api/cron/dispatch',
    defaultIntervalMs: 60_000,
    envOverride: 'CEZAR_DISPATCH_INTERVAL_MS',
    formatLog: (b) => {
      const r = b as { claimed?: number; requeued?: number; error?: string };
      if (r.error) return `error: ${r.error}`;
      if ((r.claimed ?? 0) > 0 || (r.requeued ?? 0) > 0) return `claimed ${r.claimed ?? 0}, requeued ${r.requeued ?? 0}`;
      return null;
    },
  },
  {
    path: '/api/cron/triage-sweep',
    defaultIntervalMs: 600_000,
    envOverride: 'CEZAR_TRIAGE_SWEEP_INTERVAL_MS',
    formatLog: (b) => {
      const r = b as { enqueued?: number; workspaces?: number; error?: string };
      if (r.error) return `error: ${r.error}`;
      if ((r.enqueued ?? 0) > 0) return `enqueued ${r.enqueued} across ${r.workspaces} workspace(s)`;
      return null;
    },
  },
  // — Legacy crons (driven here so non-Vercel hosts don't need external cron until retirement) —
  { path: '/api/cron/issue-sync',    defaultIntervalMs: 300_000, envOverride: 'CEZAR_CRON_ISSUE_SYNC_INTERVAL_MS' },
  { path: '/api/cron/issue-match',   defaultIntervalMs:  60_000, envOverride: 'CEZAR_CRON_ISSUE_MATCH_INTERVAL_MS' },
  { path: '/api/cron/issue-fix',     defaultIntervalMs:  60_000, envOverride: 'CEZAR_CRON_ISSUE_FIX_INTERVAL_MS' },
  { path: '/api/cron/ci-watch',      defaultIntervalMs:  60_000, envOverride: 'CEZAR_CRON_CI_WATCH_INTERVAL_MS' },
  { path: '/api/cron/ci-attribute',  defaultIntervalMs:  60_000, envOverride: 'CEZAR_CRON_CI_ATTRIBUTE_INTERVAL_MS' },
  { path: '/api/cron/ci-fix',        defaultIntervalMs:  60_000, envOverride: 'CEZAR_CRON_CI_FIX_INTERVAL_MS' },
];

interface SchedulerState {
  intervals: Array<ReturnType<typeof setInterval>>;
  inflight: Map<string, boolean>;
}

function getState(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState>;
  if (!g[FLAG]) g[FLAG] = { intervals: [], inflight: new Map() };
  return g[FLAG];
}

function resolveBaseUrl(): string {
  return (
    process.env.CEZAR_INPROCESS_CRON_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
    `http://127.0.0.1:${process.env.PORT || '3000'}`
  );
}

function disabledPaths(): Set<string> {
  return new Set(
    (process.env.CEZAR_INPROCESS_CRON_DISABLED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function hit(path: string, baseUrl: string, secret?: string): Promise<unknown> {
  const url = baseUrl.replace(/\/$/, '') + path;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return body;
}

/** Start the in-process scheduler. Safe to call multiple times. */
export function startInProcessScheduler(): void {
  const state = getState();
  if (state.intervals.length > 0) return;

  const baseUrl = resolveBaseUrl();
  const secret = process.env.CRON_SECRET;
  const disabled = disabledPaths();
  const skipLegacy = process.env.CEZAR_INPROCESS_CRON_LEGACY === 'false';

  const active = JOBS.filter((j) => {
    if (disabled.has(j.path)) return false;
    if (skipLegacy && j.path !== '/api/cron/dispatch' && j.path !== '/api/cron/triage-sweep') return false;
    return true;
  }).map((j) => ({ job: j, intervalMs: Number(process.env[j.envOverride]) || j.defaultIntervalMs }));

  const summary = active.map((a) => `${a.job.path}@${a.intervalMs}ms`).join(', ');
  console.log(`[scheduler] starting — base ${baseUrl}; ${active.length} job(s): ${summary || '(none)'}`);

  for (const { job, intervalMs } of active) {
    const tick = async () => {
      if (state.inflight.get(job.path)) return; // skip overlap
      state.inflight.set(job.path, true);
      try {
        const body = await hit(job.path, baseUrl, secret);
        const line = job.formatLog
          ? job.formatLog(body)
          : `ok`; // generic: legacy routes return varied shapes — only log when something noteworthy
        if (line !== null && line !== 'ok') console.log(`[scheduler] ${job.path} — ${line}`);
      } catch (err) {
        console.error(`[scheduler] ${job.path} threw:`, err instanceof Error ? err.message : err);
      } finally {
        state.inflight.set(job.path, false);
      }
    };
    state.intervals.push(setInterval(tick, intervalMs));
  }

  const shutdown = (signal: string) => {
    console.log(`[scheduler] ${signal} — stopping`);
    stopInProcessScheduler();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export function stopInProcessScheduler(): void {
  const state = getState();
  for (const iv of state.intervals) clearInterval(iv);
  state.intervals = [];
  state.inflight.clear();
}
