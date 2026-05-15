import type { Config, Store, CiFollowupInput } from '@cezar/core';

// ─── wire shapes ────────────────────────────────────────────────────────
// What `GET /api/runner/jobs` returns when there's work. The SaaS has already
// created the `workflow_runs` row (so the runner only POSTs events / PATCHes
// the final state) and minted a short-lived GitHub token.
export interface ClaimedJob {
  job: {
    id: string;
    workspaceId: string;
    repo: string | null;
    kind: 'triage' | 'autofix' | 'ci-followup';
    issueNumber: number | null;
    prNumber: number | null;
    requiredBackend: string | null;
  };
  workflowRunId: string;
  workspace: { id: string; owner: string; repo: string };
  /** Merged workspace config (cosmiconfig defaults + workspace overrides), minus
   * secrets EXCEPT `github.token`, which the runner needs to clone/comment. */
  config: Config;
  githubToken: string;
  /** Full issue-store snapshot (`IssueStore.getAllData()`) for the workspace. */
  store: Store;
  /** For `ci-followup` jobs only — lifted off `jobs.payload.ciFollowup`. */
  ciFollowupSeed: CiFollowupInput | null;
}

/** One streamed event the runner POSTs back to `/api/runner/runs/:id/events`. */
export interface RunnerEvent {
  type: 'lifecycle' | 'agent-text' | 'tool-call' | 'tool-result' | 'note' | 'step-start' | 'step-end';
  payload: unknown;
  /** Step lifecycle (`step-start`/`step-end`) carries these so the SaaS can
   * upsert an `agent_runs` row + advance `workflow_runs.current_step_id`. */
  stepId?: string;
  iteration?: number;
  kind?: string;
  backend?: string | null;
  model?: string | null;
  status?: string;
  summary?: string | null;
  error?: string | null;
  tokensUsed?: number;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface FinalizeRunBody {
  status: 'succeeded' | 'failed' | 'paused' | 'cancelled' | 'dry-run' | 'pr-opened' | 'pushed' | 'skipped';
  outcome?: unknown;
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  headSha?: string | null;
  tokensUsed?: number;
  reason?: string | null;
}

export interface HeartbeatBody {
  status?: 'online' | 'draining' | 'offline';
  currentJobIds?: string[];
}

export interface HeartbeatReply {
  ok: true;
  /** Jobs this runner holds whose row was marked `cancelled` — abort them. */
  cancelJobIds: string[];
  /** Workflow runs this runner is driving whose `pause_requested` is set. */
  pauseRunIds: string[];
}

// ─── client ─────────────────────────────────────────────────────────────

const MAX_RETRIES = 4;

/** Thin bearer-authed HTTP client for the SaaS runner API. Retries 5xx/network
 * with exponential backoff; throws hard on 401 (bad/revoked token). */
export class RunnerClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async claimJob(backends: string[]): Promise<ClaimedJob | null> {
    const qs = backends.length ? `?backends=${encodeURIComponent(backends.join(','))}` : '';
    const body = await this.request<{ job: null } | ClaimedJob>('GET', `/api/runner/jobs${qs}`);
    if (!body || (body as { job: null }).job === null) return null;
    return body as ClaimedJob;
  }

  async postEvents(workflowRunId: string, events: RunnerEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.request('POST', `/api/runner/runs/${workflowRunId}/events`, { events });
  }

  async finalizeRun(workflowRunId: string, body: FinalizeRunBody): Promise<void> {
    await this.request('PATCH', `/api/runner/runs/${workflowRunId}`, body);
  }

  async heartbeat(body: HeartbeatBody): Promise<HeartbeatReply> {
    return this.request<HeartbeatReply>('POST', '/api/runner/heartbeat', body);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 401) throw new Error(`runner token rejected (401) for ${method} ${path}`);
        if (res.status >= 500) throw new RetryableError(`${method} ${path} → ${res.status}`);
        if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text().catch(() => '')}`);
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      } catch (err) {
        lastErr = err;
        // 401 (and other non-retryable) — bail immediately.
        if (err instanceof Error && err.message.includes('(401)')) throw err;
        if (!(err instanceof RetryableError) && !isNetworkError(err)) throw err;
        if (attempt === MAX_RETRIES) break;
        await sleep(250 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

class RetryableError extends Error {}

function isNetworkError(err: unknown): boolean {
  // `fetch` throws a TypeError on connection failures / DNS / ECONNREFUSED.
  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
