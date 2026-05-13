// In-process scheduler for self-hosted Node deployments — drives the dispatcher
// and triage-sweep on `setInterval` from inside the Next.js server process.
//
// Booted by `src/instrumentation.ts` when `CEZAR_INPROCESS_CRON=true` and the
// runtime is `nodejs`. Idempotent via a `globalThis` flag so dev-mode HMR
// reloads don't spawn duplicate timers. In multi-replica deployments every
// replica ticks — that's safe (the dispatcher's `claim_next_job` uses
// `FOR UPDATE SKIP LOCKED`, the sweep dedupes), just wasteful.
//
// Implementation note: this driver `fetch`es the local `/api/cron/dispatch`
// and `/api/cron/triage-sweep` routes rather than importing their handler
// modules directly. That keeps `@cezar/core` (and its `cosmiconfig` →
// Node-builtins transitive deps) out of the bundle Next.js generates for the
// Edge-runtime build of `instrumentation.ts`. The cron routes themselves run
// on the Node runtime, so the actual work happens in the same process — the
// `fetch` is a localhost round-trip, not a real network hop.
//
// Vercel deployments should keep using the `vercel.json` cron schedules and
// leave `CEZAR_INPROCESS_CRON` unset.

const FLAG = Symbol.for('cezar.inProcessScheduler.started');

interface SchedulerState {
  dispatchInterval: ReturnType<typeof setInterval> | null;
  sweepInterval: ReturnType<typeof setInterval> | null;
  dispatchInflight: boolean;
  sweepInflight: boolean;
}

function getState(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState>;
  if (!g[FLAG]) {
    g[FLAG] = { dispatchInterval: null, sweepInterval: null, dispatchInflight: false, sweepInflight: false };
  }
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

async function hit(path: string, secret?: string): Promise<unknown> {
  const url = resolveBaseUrl().replace(/\/$/, '') + path;
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
  if (state.dispatchInterval || state.sweepInterval) return;

  const dispatchMs = Number(process.env.CEZAR_DISPATCH_INTERVAL_MS) || 60_000;
  const sweepMs = Number(process.env.CEZAR_TRIAGE_SWEEP_INTERVAL_MS) || 600_000;
  const secret = process.env.CRON_SECRET;
  const baseUrl = resolveBaseUrl();

  console.log(`[scheduler] starting — base ${baseUrl}; dispatch every ${dispatchMs}ms, triage-sweep every ${sweepMs}ms`);

  const tickDispatch = async () => {
    if (state.dispatchInflight) return;
    state.dispatchInflight = true;
    try {
      const result = (await hit('/api/cron/dispatch', secret)) as { claimed?: number; requeued?: number; error?: string };
      if ((result.claimed ?? 0) > 0 || (result.requeued ?? 0) > 0) {
        console.log(`[scheduler] dispatch — claimed ${result.claimed ?? 0}, requeued ${result.requeued ?? 0}`);
      }
      if (result.error) console.error(`[scheduler] dispatch error: ${result.error}`);
    } catch (err) {
      console.error('[scheduler] dispatch threw:', err instanceof Error ? err.message : err);
    } finally {
      state.dispatchInflight = false;
    }
  };

  const tickSweep = async () => {
    if (state.sweepInflight) return;
    state.sweepInflight = true;
    try {
      const result = (await hit('/api/cron/triage-sweep', secret)) as { enqueued?: number; workspaces?: number; error?: string };
      if ((result.enqueued ?? 0) > 0) {
        console.log(`[scheduler] triage-sweep — enqueued ${result.enqueued} across ${result.workspaces} workspace(s)`);
      }
      if (result.error) console.error(`[scheduler] triage-sweep error: ${result.error}`);
    } catch (err) {
      console.error('[scheduler] triage-sweep threw:', err instanceof Error ? err.message : err);
    } finally {
      state.sweepInflight = false;
    }
  };

  state.dispatchInterval = setInterval(tickDispatch, dispatchMs);
  state.sweepInterval = setInterval(tickSweep, sweepMs);

  const shutdown = (signal: string) => {
    console.log(`[scheduler] ${signal} — stopping`);
    stopInProcessScheduler();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

export function stopInProcessScheduler(): void {
  const state = getState();
  if (state.dispatchInterval) {
    clearInterval(state.dispatchInterval);
    state.dispatchInterval = null;
  }
  if (state.sweepInterval) {
    clearInterval(state.sweepInterval);
    state.sweepInterval = null;
  }
}
