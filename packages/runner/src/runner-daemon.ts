import { RunnerClient, type ClaimedJob } from './runner-client.js';
import { executeJobLocally } from './execute-job-locally.js';

export interface RunnerDaemonConfig {
  url: string;
  token: string;
  /** Backends this runner advertises (and the `claim` filter). */
  backends: string[];
  kind: 'cloud' | 'self-hosted';
  /** Max concurrent jobs. Default 1. */
  concurrency?: number;
  /** Seconds between claim attempts (and the heartbeat is sent every other tick). Default 5. */
  pollIntervalSec?: number;
}

interface InFlight {
  jobId: string;
  workflowRunId: string;
  pause: boolean;
  cancel: boolean;
  done: Promise<void>;
}

/**
 * The runner loop: long-polls the SaaS for jobs it can serve, runs them locally
 * (streaming events back), heartbeats so the watchdog knows it's alive, and on
 * SIGINT/SIGTERM stops claiming, lets in-flight jobs finish (grace timeout),
 * sends a final `offline` heartbeat.
 *
 * Pause/cancel reach a running job via the heartbeat reply (`cancelJobIds` /
 * `pauseRunIds`) — no separate poll. The daemon flips a per-job flag the job's
 * pause/cancel probes read between steps.
 */
export class RunnerDaemon {
  private readonly client: RunnerClient;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly inFlight = new Map<string, InFlight>();
  private stopping = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: RunnerDaemonConfig) {
    this.client = new RunnerClient(cfg.url, cfg.token);
    this.concurrency = Math.max(1, cfg.concurrency ?? 1);
    this.pollMs = Math.max(1000, (cfg.pollIntervalSec ?? 5) * 1000);
  }

  async start(): Promise<void> {
    process.on('SIGINT', () => { void this.shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void this.shutdown('SIGTERM'); });

    console.log(`[runner] starting — kind=${this.cfg.kind} backends=${this.cfg.backends.join(',')} concurrency=${this.concurrency}`);
    await this.heartbeat('online');

    this.heartbeatTimer = setInterval(() => { void this.heartbeat('online'); }, this.pollMs * 2);
    const tick = async (): Promise<void> => {
      if (!this.stopping) {
        try { await this.claimAndRun(); } catch (err) {
          console.error('[runner] claim tick failed:', err instanceof Error ? err.message : err);
          if (err instanceof Error && err.message.includes('(401)')) { await this.shutdown('auth-error'); return; }
        }
      }
      if (!this.stopping) this.loopTimer = setTimeout(() => { void tick(); }, this.pollMs);
    };
    void tick();

    // Keep the process alive until shutdown resolves.
    await new Promise<void>((resolve) => { this.resolveExit = resolve; });
  }

  private resolveExit: (() => void) | null = null;

  private async claimAndRun(): Promise<void> {
    while (this.inFlight.size < this.concurrency && !this.stopping) {
      const claimed = await this.client.claimJob(this.cfg.backends);
      if (!claimed) return;
      this.runJob(claimed);
    }
  }

  private runJob(claimed: ClaimedJob): void {
    const entry: InFlight = {
      jobId: claimed.job.id,
      workflowRunId: claimed.workflowRunId,
      pause: false,
      cancel: false,
      done: Promise.resolve(),
    };
    this.inFlight.set(claimed.job.id, entry);
    console.log(`[runner] running job ${claimed.job.id} (${claimed.job.kind} #${claimed.job.issueNumber ?? '?'})`);
    entry.done = executeJobLocally(this.client, claimed, {
      shouldPause: () => entry.pause, // shutdown does NOT pause — in-flight jobs run to completion
      shouldCancel: () => entry.cancel,
    }).catch((err) => {
      console.error(`[runner] job ${claimed.job.id} crashed:`, err instanceof Error ? err.message : err);
    }).finally(() => {
      this.inFlight.delete(claimed.job.id);
      console.log(`[runner] job ${claimed.job.id} finished (${this.inFlight.size} in flight)`);
    });
  }

  private async heartbeat(status: 'online' | 'draining' | 'offline'): Promise<void> {
    try {
      const reply = await this.client.heartbeat({ status, currentJobIds: [...this.inFlight.keys()] });
      for (const jobId of reply.cancelJobIds ?? []) {
        const e = this.inFlight.get(jobId);
        if (e && !e.cancel) { e.cancel = true; console.log(`[runner] cancel requested for job ${jobId}`); }
      }
      for (const runId of reply.pauseRunIds ?? []) {
        for (const e of this.inFlight.values()) {
          if (e.workflowRunId === runId && !e.pause) { e.pause = true; console.log(`[runner] pause requested for run ${runId}`); }
        }
      }
    } catch (err) {
      console.error('[runner] heartbeat failed:', err instanceof Error ? err.message : err);
      if (err instanceof Error && err.message.includes('(401)')) await this.shutdown('auth-error');
    }
  }

  private async shutdown(why: string): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    console.log(`[runner] shutting down (${why}) — ${this.inFlight.size} job(s) in flight`);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.heartbeat('draining').catch(() => {});

    // Grace period for in-flight jobs.
    const GRACE_MS = 5 * 60_000;
    const pending = [...this.inFlight.values()].map((e) => e.done);
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, GRACE_MS)),
    ]);
    if (this.inFlight.size > 0) {
      console.warn(`[runner] ${this.inFlight.size} job(s) still running at grace timeout — leaving them for the watchdog`);
    }
    await this.heartbeat('offline').catch(() => {});
    this.resolveExit?.();
    // Give the final heartbeat a beat to flush, then exit.
    setTimeout(() => process.exit(0), 250);
  }
}
