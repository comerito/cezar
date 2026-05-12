import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgentRunRecord } from '@cezar/core';
import { SupabaseStoreAdapter } from './adapters/supabase-store';
import { loadWorkspaceConfig } from './load-workspace-config';
import { EventBridge } from './adapters/event-bridge';
import { WebConfirmAdapter } from './adapters/web-confirm';
import { ensureRepoClone } from './repo-clone';
import type { Database, AgentRunEventType } from './supabase/types';

export interface RunOrchestratorOpts {
  flowId: string;
  workspaceId: string;
  issueNumber: number;
  mode: 'apply' | 'dry-run';
  githubToken: string;
  /**
   * 'interactive' — gate on the WebConfirmAdapter (or auto-proceed via the
   *   workspace's autoProceedConfidence threshold, mirroring the user-driven
   *   path in app/flows/actions.ts).
   * 'autonomous' — always proceed, regardless of confidence. Used by the
   *   cron-driven dispatcher where there is no user to ask.
   */
  confirmPolicy: 'interactive' | 'autonomous';
  /** Optional lifecycle line emitted just before processIssue starts. */
  initLifecycle?: string;
}

/**
 * Runs the autofix orchestrator and writes the outcome back to the flows row.
 * Shared between the user-driven Server Action (app/flows/actions.ts) and the
 * cron-driven autonomous dispatcher (api/cron/issue-fix). Both call sites
 * fire-and-forget — failures inside here mark the flow failed and return.
 *
 * Phase 3a: when the workspace has `config.workflow.useEngine` on, the
 * orchestrator delegates to the declarative workflow engine — in that case we
 * ALSO persist a `workflow_runs` row + `agent_runs` + `agent_run_events` (the
 * cockpit's backing tables) alongside the existing `flows`/`flow_events` writes.
 * When the flag is off, behavior is unchanged (new tables untouched).
 */
export async function runOrchestrator(
  supabase: SupabaseClient<Database>,
  opts: RunOrchestratorOpts,
): Promise<void> {
  const { flowId, workspaceId, issueNumber, mode, githubToken, confirmPolicy, initLifecycle } = opts;
  const eventBridge = new EventBridge(flowId, supabase);
  const confirmAdapter = new WebConfirmAdapter(flowId, supabase);

  // Phase 3a workflow-run persistence state (only used when useEngine is on).
  let workflowRunId: string | null = null;
  const safe = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try { await fn(); } catch (err) {
      eventBridge.lifecycle(`(cockpit persist) ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const recordEvent = (type: AgentRunEventType, payload: unknown, agentRunId?: string | null): void => {
    if (!workflowRunId) return;
    void safe(`event:${type}`, async () => {
      await supabase.from('agent_run_events').insert({
        workspace_id: workspaceId,
        workflow_run_id: workflowRunId!,
        agent_run_id: agentRunId ?? null,
        type,
        payload: payload as Database['public']['Tables']['agent_run_events']['Row']['payload'],
      });
    });
  };

  try {
    const core = await import('@cezar/core');
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);

    const config = await loadWorkspaceConfig(workspaceId, supabase, { githubToken });

    if (!config.autofix.repoRoot) {
      eventBridge.lifecycle('Cloning repository...');
      const repoRoot = await ensureRepoClone(
        config.github.owner,
        config.github.repo,
        config.github.token,
        config.autofix.baseBranch,
      );
      config.autofix.repoRoot = repoRoot;
      eventBridge.lifecycle(`Repository cloned to ${repoRoot}`);
    }

    const github = new core.GitHubService(config);

    const autoProceedThreshold = Number((config.autofix as any).autoProceedConfidence) || 0;
    const useEngine = config.workflow?.useEngine === true;
    const repoSlug = config.github.owner && config.github.repo ? `${config.github.owner}/${config.github.repo}` : null;

    if (useEngine) {
      await safe('workflow_runs insert', async () => {
        const { data, error } = await supabase
          .from('workflow_runs')
          .insert({
            workspace_id: workspaceId,
            job_id: null,
            workflow: 'autofix',
            repo: repoSlug,
            issue_number: issueNumber,
            status: 'running',
          })
          .select('id')
          .single();
        if (error) throw error;
        workflowRunId = data?.id ?? null;
      });
    }

    if (initLifecycle) eventBridge.lifecycle(initLifecycle);

    const onRunRecord = useEngine
      ? (r: AgentRunRecord) => {
          void safe('agent_runs insert', async () => {
            if (!workflowRunId) return;
            const { data, error } = await supabase
              .from('agent_runs')
              .insert({
                workspace_id: workspaceId,
                workflow_run_id: workflowRunId,
                step_id: r.stepId,
                iteration: r.iteration,
                kind: (r.kind ?? null) as Database['public']['Tables']['agent_runs']['Row']['kind'],
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
            // The engine fires onRunRecord once the step is done, so emit a
            // single step-end event mirroring it (step-start is implicit).
            recordEvent('step-end', { stepId: r.stepId, iteration: r.iteration, status: r.status, summary: r.summary, error: r.error }, data?.id);
            await supabase.from('workflow_runs').update({ current_step_id: r.stepId }).eq('id', workflowRunId);
          });
        }
      : undefined;

    const orchestrator = new core.AutofixOrchestrator(store, config, github);
    const outcome = await orchestrator.processIssue(issueNumber, {
      apply: mode === 'apply',
      confirmBeforeFix: async (rootCause, issue) => {
        if (confirmPolicy === 'autonomous') return true;
        if (autoProceedThreshold > 0 && rootCause.confidence >= autoProceedThreshold) {
          eventBridge.lifecycle(
            `Auto-proceeding (confidence ${Math.round(rootCause.confidence * 100)}% ≥ threshold ${Math.round(autoProceedThreshold * 100)}%)`,
          );
          return true;
        }
        const prompt = {
          issueNumber: issue.number,
          issueTitle: issue.title,
          rootCause: rootCause.summary,
          confidence: rootCause.confidence,
          evidence: rootCause.suspectedFiles,
        };
        const decision = await confirmAdapter.confirmRootCause(prompt);
        return decision === 'proceed';
      },
      onEvent: (msg) => {
        eventBridge.lifecycle(msg);
        recordEvent('lifecycle', { message: msg });
      },
      onAgentEvent: (evt) => {
        eventBridge.agent(evt);
        // Map the legacy agent-session event onto an agent_run_events row.
        if (evt.type === 'text') recordEvent('agent-text', { text: evt.text });
        else if (evt.type === 'tool') recordEvent('tool-call', { tool: evt.tool, input: evt.input });
        else if (evt.type === 'tool-result') recordEvent('tool-result', { toolUseId: evt.toolUseId, result: evt.result, isError: evt.isError });
        else recordEvent('note', evt);
      },
      onRunRecord,
    });

    await supabase
      .from('flows')
      .update({
        status: outcome.status === 'dry-run' ? 'succeeded' : outcome.status,
        outcome: outcome as any,
        pr_url: 'prUrl' in outcome ? outcome.prUrl : null,
        pr_number: 'prNumber' in outcome ? outcome.prNumber : null,
        branch: 'branch' in outcome ? outcome.branch : null,
        head_sha: 'headSha' in outcome ? outcome.headSha : null,
        // Prime the CI watcher: pr-opened flows start as 'pending' so the
        // Vercel cron picks them up on the next tick.
        ci_status: outcome.status === 'pr-opened' ? 'pending' : null,
      } as any)
      .eq('id', flowId);

    if (useEngine && workflowRunId) {
      await safe('workflow_runs finalize', async () => {
        const status =
          outcome.status === 'pr-opened' || outcome.status === 'dry-run' || outcome.status === 'skipped'
            ? 'succeeded'
            : 'failed';
        await supabase
          .from('workflow_runs')
          .update({
            status,
            outcome: outcome as Database['public']['Tables']['workflow_runs']['Row']['outcome'],
            reason: 'reason' in outcome ? outcome.reason : null,
            pr_url: 'prUrl' in outcome ? outcome.prUrl : null,
            pr_number: 'prNumber' in outcome ? outcome.prNumber : null,
            branch: 'branch' in outcome ? outcome.branch : null,
            head_sha: 'headSha' in outcome ? outcome.headSha : null,
            finished_at: new Date().toISOString(),
          })
          .eq('id', workflowRunId!);
      });
    }

    await store.save();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    eventBridge.lifecycle(`FATAL: ${message}`);
    await supabase
      .from('flows')
      .update({ status: 'failed', outcome: { status: 'failed', reason: message } as any })
      .eq('id', flowId);
    if (workflowRunId) {
      await safe('workflow_runs fail', async () => {
        await supabase
          .from('workflow_runs')
          .update({ status: 'failed', reason: message, finished_at: new Date().toISOString() })
          .eq('id', workflowRunId!);
      });
    }
  } finally {
    setTimeout(() => eventBridge.dispose(), 3000);
  }
}
