import type { AgentRunRecord, Config } from '@cezar/core';
import type { ClaimedJob, RunnerEvent } from './runner-client.js';
import { RunnerClient } from './runner-client.js';
import { ensureRepoCloneLocal } from './repo-clone.js';

export interface ExecuteJobControls {
  /** Polled between steps — true ⇒ finish the current step then pause the run. */
  shouldPause: () => boolean;
  /** Polled between steps — true ⇒ end the run `cancelled`. */
  shouldCancel: () => boolean;
}

const FLUSH_INTERVAL_MS = 1000;
const FLUSH_BATCH = 25;

/**
 * Runs a claimed workflow job on this runner and reports state back over HTTP.
 * The SaaS already created the `workflow_runs` row (returned as `workflowRunId`)
 * and minted `githubToken`; this only POSTs events + PATCHes the final state.
 *
 * Never throws — a failure is reported via `finalizeRun(status:'failed')`.
 */
export async function executeJobLocally(
  client: RunnerClient,
  claimed: ClaimedJob,
  controls: ExecuteJobControls,
): Promise<void> {
  const { workflowRunId, job, workspace, githubToken, ciFollowupSeed } = claimed;

  // ── event buffer ──────────────────────────────────────────────────────
  const buffer: RunnerEvent[] = [];
  let tokensUsed = 0;
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer.splice(0, buffer.length);
    try {
      await client.postEvents(workflowRunId, batch);
    } catch (err) {
      // Re-queue so we don't silently drop them; if the API is down the daemon
      // will eventually surface it elsewhere.
      buffer.unshift(...batch);
      console.error(`[runner] postEvents failed (${batch.length} buffered):`, err instanceof Error ? err.message : err);
    } finally {
      flushing = false;
    }
  };
  const timer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  const emit = (e: RunnerEvent): void => {
    if (typeof e.tokensUsed === 'number') tokensUsed += e.tokensUsed;
    buffer.push(e);
    if (buffer.length >= FLUSH_BATCH) void flush();
  };

  const onEvent = (msg: string): void => emit({ type: 'lifecycle', payload: { message: msg } });
  const onAgentEvent = (evt: { type: string; [k: string]: unknown }): void => {
    // The orchestrator/engine path emits the legacy agent-session event shape.
    if (evt.type === 'text') emit({ type: 'agent-text', payload: { text: evt.text } });
    else if (evt.type === 'tool') emit({ type: 'tool-call', payload: { tool: evt.tool, input: evt.input } });
    else if (evt.type === 'tool-result') emit({ type: 'tool-result', payload: { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError } });
    else emit({ type: 'note', payload: evt });
  };
  const onRunRecord = (r: AgentRunRecord): void => {
    emit({
      type: 'step-start',
      stepId: r.stepId,
      iteration: r.iteration,
      kind: r.kind ?? undefined,
      backend: r.backend,
      model: r.model,
      status: 'running',
      startedAt: r.startedAt,
      payload: { stepId: r.stepId, iteration: r.iteration },
    });
    emit({
      type: 'step-end',
      stepId: r.stepId,
      iteration: r.iteration,
      kind: r.kind ?? undefined,
      backend: r.backend,
      model: r.model,
      status: r.status,
      summary: r.summary ?? null,
      error: r.error ?? null,
      tokensUsed: r.tokensUsed,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      payload: { stepId: r.stepId, iteration: r.iteration, status: r.status, summary: r.summary, error: r.error },
    });
  };

  const pauseRequested = async (): Promise<boolean> => controls.shouldPause();
  const cancelRequested = async (): Promise<boolean> => controls.shouldCancel();

  try {
    const core = await import('@cezar/core');

    // Build the runtime Config from the SaaS-supplied merged config.
    const config: Config = claimed.config;
    config.github = { ...config.github, owner: workspace.owner, repo: workspace.repo, token: githubToken };
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };
    if (!config.autofix.repoRoot) {
      config.autofix.repoRoot = await ensureRepoCloneLocal(workspace.owner, workspace.repo, githubToken, config.autofix.baseBranch);
    }

    // No Supabase here — reconstruct the store from the snapshot. Store mutations
    // (autofixStatus etc.) are best-effort lost; round-tripping them is TODO(phase-4).
    const store = core.IssueStore.fromData(claimed.store);
    const github = new core.GitHubService(config);

    type Result = {
      status: 'succeeded' | 'failed' | 'paused' | 'cancelled';
      finalize: import('./runner-client.js').FinalizeRunBody;
    };
    let result: Result;

    if (job.kind === 'autofix') {
      if (job.issueNumber == null) throw new Error('autofix job has no issue_number');
      const outcome = await new core.AutofixOrchestrator(store, config, github).processIssue(job.issueNumber, {
        apply: true, onEvent, onAgentEvent, onRunRecord, pauseRequested, cancelRequested,
      });
      const ok = outcome.status === 'pr-opened' || outcome.status === 'dry-run' || outcome.status === 'skipped';
      result = {
        status: ok ? 'succeeded' : 'failed',
        finalize: {
          status: outcome.status === 'pr-opened' ? 'pr-opened' : outcome.status === 'dry-run' ? 'dry-run' : outcome.status === 'skipped' ? 'skipped' : 'failed',
          outcome,
          reason: 'reason' in outcome ? outcome.reason : null,
          prUrl: 'prUrl' in outcome ? outcome.prUrl : null,
          prNumber: 'prNumber' in outcome ? outcome.prNumber : (job.prNumber ?? null),
          branch: 'branch' in outcome ? outcome.branch ?? null : null,
          headSha: 'headSha' in outcome ? outcome.headSha ?? null : null,
          tokensUsed,
        },
      };
    } else if (job.kind === 'ci-followup') {
      if (!ciFollowupSeed) throw new Error('ci-followup job is missing payload.ciFollowup seed');
      const outcome = await new core.AutofixOrchestrator(store, config, github).processCiFollowup(ciFollowupSeed, {
        apply: true, onEvent, onAgentEvent, onRunRecord, pauseRequested, cancelRequested,
      });
      const ok = outcome.status === 'pushed' || outcome.status === 'skipped';
      result = {
        status: ok ? 'succeeded' : 'failed',
        finalize: {
          status: outcome.status === 'pushed' ? 'pushed' : outcome.status === 'skipped' ? 'skipped' : 'failed',
          outcome,
          reason: 'reason' in outcome ? outcome.reason : null,
          branch: 'branch' in outcome ? outcome.branch ?? null : (ciFollowupSeed.branch ?? null),
          headSha: 'headSha' in outcome ? outcome.headSha ?? null : null,
          prNumber: ciFollowupSeed.prNumber ?? (job.prNumber ?? null),
          tokensUsed,
        },
      };
    } else {
      // TODO(2b3+): wire the data-driven `runTriagePass` for the self-hosted
      // runner. Triage is repo-less and rare on self-hosted runners; until the
      // CLI/runner is rewritten on the new action model, skip the job so the
      // SaaS doesn't keep handing it back.
      const reason = 'triage on self-hosted runners is not supported yet — re-run from the GUI or wait for 2b3';
      onEvent(`[runner] ${reason}`);
      result = {
        status: 'succeeded',
        finalize: { status: 'skipped', outcome: { status: 'skipped', reason }, reason, tokensUsed },
      };
    }

    await flush();
    await client.finalizeRun(workflowRunId, { ...result.finalize, tokensUsed });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[runner] job ${job.id} failed:`, message);
    await flush().catch(() => {});
    await client.finalizeRun(workflowRunId, { status: 'failed', reason: message, tokensUsed }).catch((e) => {
      console.error(`[runner] finalizeRun(failed) also failed:`, e instanceof Error ? e.message : e);
    });
  } finally {
    clearInterval(timer);
    await flush().catch(() => {});
  }
}
