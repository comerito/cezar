import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentRunRecord, CiFollowupInput } from '@cezar/core';
import { SupabaseStoreAdapter } from './adapters/supabase-store';
import { loadWorkspaceConfig } from './load-workspace-config';
import { maybeEnqueueAutofixFromTriage } from './maybe-enqueue-autofix-from-triage';
import { ensureRepoClone } from './repo-clone';
import type { Database, AgentRunEventType } from './supabase/types';

type WorkflowKind = 'autofix' | 'ci-followup' | 'triage';

export interface ExecuteWorkflowJobParams {
  workspaceId: string;
  /** owner/repo as stored on the job (informational; the real owner/repo come from the workspace config). */
  repo: string | null;
  workflow: WorkflowKind;
  issueNumber?: number;
  prNumber?: number;
  /** The `jobs` row id this run drains, if any. When set, the row is finalized at the end. */
  jobId?: string | null;
  /** For `ci-followup` jobs — the seed lifted off `jobs.payload.ciFollowup` (a `CiFollowupInput`). */
  ciFollowupSeed?: CiFollowupInput;
}

type AgentRunsRow = Database['public']['Tables']['agent_runs']['Row'];

/**
 * Phase 3c — the single "run a workflow via the engine + persist
 * workflow_runs / agent_runs / agent_run_events" code path. Used by the
 * `/api/cron/dispatch` route (fire-and-forget, one call per claimed job).
 *
 * Forces `config.workflow.useEngine = true` so the orchestrator delegates to
 * the declarative engine. Honors pause/cancel by probing the `workflow_runs`
 * row between steps. Never rethrows — a failure marks the run (and job) failed.
 *
 * NOTE: this still inherits the serverless-duration caveat — a Vercel function
 * can be killed mid-run. The watchdog (`requeue_stalled_jobs`) re-queues such
 * jobs; the proper long-running runner is Phase 4.
 *
 * TODO(phase-3c): dedupe with run-orchestrator.ts — that file does the same
 * new-tables persistence inline alongside the legacy `flows` writes. Left as-is
 * for now to avoid disturbing the flows-backed UI; this helper is the engine-
 * only path the new cockpit consumes.
 */
export async function executeWorkflowJob(
  adminSupabase: SupabaseClient<Database>,
  params: ExecuteWorkflowJobParams,
): Promise<void> {
  const { workspaceId, workflow, issueNumber, prNumber, jobId, ciFollowupSeed } = params;
  let workflowRunId: string | null = null;

  const finishJob = async (status: Database['public']['Tables']['jobs']['Row']['status']): Promise<void> => {
    if (!jobId) return;
    await adminSupabase.from('jobs').update({ status, updated_at: new Date().toISOString() }).eq('id', jobId);
  };
  const finishRunRow = async (patch: Database['public']['Tables']['workflow_runs']['Update']): Promise<void> => {
    if (!workflowRunId) return;
    await adminSupabase.from('workflow_runs').update(patch).eq('id', workflowRunId);
  };

  try {
    const core = await import('@cezar/core');
    const adapter = new SupabaseStoreAdapter(adminSupabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);

    // GitHub token: prefer an installation token (if a GitHub App is wired up),
    // else fall back to the per-workspace admin token the crons use.
    let githubToken: string | null = null;
    let owner: string | undefined;
    {
      // Peek at the workspace to learn the owner before the full config load.
      const { data: ws } = await adminSupabase
        .from('workspaces')
        .select('repo_owner, repo_name')
        .eq('id', workspaceId)
        .single();
      owner = ws?.repo_owner ?? undefined;
    }
    if (owner && core.GitHubAppService.isConfigured()) {
      try {
        githubToken = await new core.GitHubAppService().getInstallationToken(owner);
      } catch (err) {
        console.error(`[dispatch] installation token failed for ${owner}:`, err instanceof Error ? err.message : err);
      }
    }
    if (!githubToken) githubToken = await resolveWorkspaceToken(workspaceId, adminSupabase);
    if (!githubToken) throw new Error('no github token available for workspace');

    const config = await loadWorkspaceConfig(workspaceId, adminSupabase, { githubToken });
    // Phase 3c — the dispatcher always runs the declarative engine.
    config.workflow = { ...(config.workflow ?? {}), useEngine: true };

    if (!config.autofix.repoRoot) {
      const repoRoot = await ensureRepoClone(
        config.github.owner,
        config.github.repo,
        config.github.token,
        config.autofix.baseBranch,
      );
      config.autofix.repoRoot = repoRoot;
    }

    const github = new core.GitHubService(config);
    const repoSlug = config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : params.repo ?? null;
    const runIssueNumber = workflow === 'ci-followup' ? ciFollowupSeed?.issueNumber ?? issueNumber : issueNumber;
    if (runIssueNumber == null) throw new Error(`workflow '${workflow}' job has no issue_number`);

    // ── workflow_runs row ──
    {
      const { data, error } = await adminSupabase
        .from('workflow_runs')
        .insert({
          workspace_id: workspaceId,
          job_id: jobId ?? null,
          workflow,
          repo: repoSlug,
          issue_number: runIssueNumber,
          pr_number: prNumber ?? ciFollowupSeed?.prNumber ?? null,
          status: 'running',
          started_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new Error(`workflow_runs insert failed: ${error.message}`);
      workflowRunId = data?.id ?? null;
    }

    // ── persistence callbacks ──
    const safe = async (label: string, fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (err) {
        console.error(`[dispatch] persist ${label} failed:`, err instanceof Error ? err.message : err);
      }
    };
    const recordEvent = (type: AgentRunEventType, payload: unknown, agentRunId?: string | null): void => {
      if (!workflowRunId) return;
      void safe(`event:${type}`, async () => {
        await adminSupabase.from('agent_run_events').insert({
          workspace_id: workspaceId,
          workflow_run_id: workflowRunId!,
          agent_run_id: agentRunId ?? null,
          type,
          payload: payload as Database['public']['Tables']['agent_run_events']['Row']['payload'],
        });
      });
    };
    const onEvent = (msg: string): void => recordEvent('lifecycle', { message: msg });
    const onAgentEvent = (evt: { type: string; [k: string]: unknown }): void => {
      // Mirrors run-orchestrator.ts — the orchestrator/engine path emits the
      // legacy agent-session event shape here.
      if (evt.type === 'text') recordEvent('agent-text', { text: evt.text });
      else if (evt.type === 'tool') recordEvent('tool-call', { tool: evt.tool, input: evt.input });
      else if (evt.type === 'tool-result') recordEvent('tool-result', { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError });
      else recordEvent('note', evt);
    };
    const onRunRecord = (r: AgentRunRecord): void => {
      void safe('agent_runs insert', async () => {
        if (!workflowRunId) return;
        const { data, error } = await adminSupabase
          .from('agent_runs')
          .insert({
            workspace_id: workspaceId,
            workflow_run_id: workflowRunId,
            step_id: r.stepId,
            iteration: r.iteration,
            kind: (r.kind ?? null) as AgentRunsRow['kind'],
            backend: r.backend,
            model: r.model,
            status: r.status === 'running' ? 'running' : r.status,
            started_at: r.startedAt,
            finished_at: r.finishedAt ?? null,
            tokens_used: r.tokensUsed,
            summary: r.summary ?? null,
            error: r.error ?? null,
          })
          .select('id')
          .single();
        if (error) throw error;
        recordEvent('step-end', { stepId: r.stepId, iteration: r.iteration, status: r.status, summary: r.summary, error: r.error }, data?.id);
        await adminSupabase.from('workflow_runs').update({ current_step_id: r.stepId }).eq('id', workflowRunId);
      });
    };

    // Probes the workflow_runs row between steps.
    const pauseRequested = async (): Promise<boolean> => {
      if (!workflowRunId) return false;
      const { data } = await adminSupabase.from('workflow_runs').select('pause_requested').eq('id', workflowRunId).single();
      return data?.pause_requested === true;
    };
    const cancelRequested = async (): Promise<boolean> => {
      if (!workflowRunId) return false;
      const { data } = await adminSupabase.from('workflow_runs').select('status').eq('id', workflowRunId).single();
      return data?.status === 'cancelled';
    };

    // ── run ──
    type RunStatus = 'succeeded' | 'failed' | 'paused' | 'cancelled';
    let runStatus: RunStatus = 'succeeded';
    let reason: string | undefined;
    let prUrl: string | null = null;
    let outPrNumber: number | null = prNumber ?? null;
    let branch: string | null = null;
    let headSha: string | null = null;
    let tokensUsed = 0;
    let outcomeJson: unknown = null;

    if (workflow === 'autofix') {
      const orch = new core.AutofixOrchestrator(store, config, github);
      const outcome = await orch.processIssue(runIssueNumber, {
        apply: true,
        confirmBeforeFix: undefined, // dispatcher = autonomous
        onEvent,
        onAgentEvent,
        onRunRecord,
        pauseRequested,
        cancelRequested,
      });
      outcomeJson = outcome;
      runStatus =
        outcome.status === 'pr-opened' || outcome.status === 'dry-run' || outcome.status === 'skipped'
          ? 'succeeded'
          : 'failed';
      reason = 'reason' in outcome ? outcome.reason : undefined;
      prUrl = 'prUrl' in outcome ? outcome.prUrl : null;
      outPrNumber = 'prNumber' in outcome ? outcome.prNumber : outPrNumber;
      branch = 'branch' in outcome ? outcome.branch ?? null : null;
      headSha = 'headSha' in outcome ? outcome.headSha ?? null : null;
    } else if (workflow === 'ci-followup') {
      if (!ciFollowupSeed) throw new Error('ci-followup job is missing payload.ciFollowup seed');
      const orch = new core.AutofixOrchestrator(store, config, github);
      const outcome = await orch.processCiFollowup(ciFollowupSeed, {
        apply: true,
        onEvent,
        onAgentEvent,
        onRunRecord,
        pauseRequested,
        cancelRequested,
      });
      outcomeJson = outcome;
      runStatus = outcome.status === 'pushed' || outcome.status === 'skipped' ? 'succeeded' : 'failed';
      reason = 'reason' in outcome ? outcome.reason : undefined;
      branch = 'branch' in outcome ? outcome.branch ?? null : ciFollowupSeed.branch ?? null;
      headSha = 'headSha' in outcome ? outcome.headSha ?? null : null;
      outPrNumber = ciFollowupSeed.prNumber ?? outPrNumber;
    } else {
      // triage — repo-less classification workflow (docs §3.2). The blackboard
      // ends carrying route/isBug/priority; we lift those into `outcome` so the
      // autofix-enqueue helper (below) — and the runner-finalize PATCH route —
      // can decide whether to queue an autofix job.
      const result = await core.runWorkflow(core.triageWorkflow, {
        store,
        config,
        github,
        issueNumber: runIssueNumber,
        apply: true,
        bindings: config.workflow?.bindings,
        settings: config.workflow?.settings,
        onEvent,
        onAgentEvent: undefined,
        onRunRecord,
        pauseRequested,
        cancelRequested,
      });
      const triageOutcome = core.triageOutcomeFromBlackboard(result.blackboard);
      outcomeJson = { status: result.status, reason: result.reason, ...triageOutcome };
      runStatus =
        result.status === 'succeeded' ? 'succeeded'
        : result.status === 'paused' ? 'paused'
        : result.status === 'cancelled' ? 'cancelled'
        : 'failed';
      reason = result.reason;
      tokensUsed = result.tokensUsed;
      if (runStatus === 'succeeded') {
        await maybeEnqueueAutofixFromTriage(adminSupabase, {
          workspaceId,
          repo: repoSlug,
          issueNumber: runIssueNumber,
          outcome: triageOutcome,
          workspaceConfig: config,
        });
      }
    }

    // The engine path doesn't surface tokensUsed through the autofix outcome,
    // but the run records do; sum them as a best-effort total when unknown.
    if (tokensUsed === 0 && workflowRunId) {
      const { data: runs } = await adminSupabase.from('agent_runs').select('tokens_used').eq('workflow_run_id', workflowRunId);
      tokensUsed = (runs ?? []).reduce((s, r) => s + (r.tokens_used ?? 0), 0);
    }

    await finishRunRow({
      status: runStatus,
      outcome: outcomeJson as Database['public']['Tables']['workflow_runs']['Row']['outcome'],
      reason: reason ?? null,
      pr_url: prUrl,
      pr_number: outPrNumber,
      branch,
      head_sha: headSha,
      tokens_used: tokensUsed,
      finished_at: new Date().toISOString(),
    });
    await finishJob(
      runStatus === 'succeeded' ? 'done'
      : runStatus === 'paused' ? 'queued' // re-queue a paused run so it's picked up again
      : runStatus === 'cancelled' ? 'cancelled'
      : 'failed',
    );

    await store.save().catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[dispatch] executeWorkflowJob failed:', message);
    await finishRunRow({ status: 'failed', reason: message, finished_at: new Date().toISOString() }).catch(() => {});
    await finishJob('failed').catch(() => {});
  }
}

/**
 * Mirrors the per-workspace token lookup in api/cron/issue-fix & issue-sync:
 * grab any workspace admin's stored GitHub token, else fall back to the
 * ambient `GITHUB_TOKEN` env var.
 */
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');
  if (admins && admins.length > 0) {
    const ids = admins.map((a) => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }
  return process.env.GITHUB_TOKEN || null;
}
