import type { SupabaseClient } from '@supabase/supabase-js';
import type { CiFollowupInput } from '@cezar/core';
import { SupabaseStoreAdapter } from './adapters/supabase-store';
import { loadWorkspaceConfig } from './load-workspace-config';
import { maybeEnqueueAutofixFromTriage } from './maybe-enqueue-autofix-from-triage';
import { createWorkflowRunPersister, type WorkflowRunPersister } from './persist-workflow-run';
import { ensureRepoClone } from './repo-clone';
import type { Database } from './supabase/types';

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
 * Persistence (`workflow_runs` / `agent_runs` / `agent_run_events`) flows
 * through {@link createWorkflowRunPersister}.
 */
export async function executeWorkflowJob(
  adminSupabase: SupabaseClient<Database>,
  params: ExecuteWorkflowJobParams,
): Promise<void> {
  const { workspaceId, workflow, issueNumber, prNumber, jobId, ciFollowupSeed } = params;
  let persister: WorkflowRunPersister | null = null;

  const finishJob = async (status: Database['public']['Tables']['jobs']['Row']['status']): Promise<void> => {
    if (!jobId) return;
    await adminSupabase.from('jobs').update({ status, updated_at: new Date().toISOString() }).eq('id', jobId);
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

    // ── workflow_runs row + persistence (the shared persister) ──
    persister = await createWorkflowRunPersister(adminSupabase, {
      workspaceId,
      jobId,
      workflow,
      repo: repoSlug,
      issueNumber: runIssueNumber,
      prNumber: prNumber ?? ciFollowupSeed?.prNumber ?? null,
      onPersistError: (label, err) =>
        console.error(`[dispatch] persist ${label} failed:`, err instanceof Error ? err.message : err),
    });
    if (!persister.id) throw new Error('workflow_runs insert failed');

    // ── persistence callbacks ──
    const onEvent = (msg: string): void => { void persister!.recordEvent('lifecycle', { message: msg }); };
    const onAgentEvent = (evt: { type: string; [k: string]: unknown }): void => {
      // The orchestrator/engine path emits the legacy agent-session event
      // shape here; map it onto agent_run_events rows.
      if (evt.type === 'text') void persister!.recordEvent('agent-text', { text: evt.text });
      else if (evt.type === 'tool') void persister!.recordEvent('tool-call', { tool: evt.tool, input: evt.input });
      else if (evt.type === 'tool-result') void persister!.recordEvent('tool-result', { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError });
      else void persister!.recordEvent('note', evt);
    };
    const onRunRecord = (r: import('@cezar/core').AgentRunRecord): void => { void persister!.recordAgentRun(r); };
    const pauseRequested = () => persister!.isPauseRequested();
    const cancelRequested = () => persister!.isCancelled();

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
        // Persist the triage classification back to the issue's analysis so the
        // follow-up autofix dispatch — which loads the store fresh and gates on
        // `issue.analysis.issueType === 'bug'` (and `bugConfidence ≥ threshold`)
        // in `AutofixOrchestrator.processIssueViaEngine` — actually proceeds.
        // Without this, every triage→autofix handoff short-circuits as
        // "not classified as a bug" with 0 steps. Must save BEFORE enqueueing.
        try {
          const nowIso = new Date().toISOString();
          store.setAnalysis(runIssueNumber, {
            issueType: triageOutcome.issueType,
            bugConfidence: triageOutcome.bugConfidence,
            bugReason: triageOutcome.bugReason,
            bugAnalyzedAt: nowIso,
            priority: triageOutcome.priority,
            priorityReason: triageOutcome.priorityReason,
            priorityAnalyzedAt: triageOutcome.priority ? nowIso : null,
          });
          await store.save();
        } catch (err) {
          console.error('[dispatch] persist triage analysis failed:', err instanceof Error ? err.message : err);
        }
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
    if (tokensUsed === 0 && persister.id) {
      const { data: runs } = await adminSupabase.from('agent_runs').select('tokens_used').eq('workflow_run_id', persister.id);
      tokensUsed = (runs ?? []).reduce((s, r) => s + (r.tokens_used ?? 0), 0);
    }

    await persister.finalize({
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
    if (persister) await persister.fail(message).catch(() => {});
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
