import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseStoreAdapter } from './adapters/supabase-store';
import { loadWorkspaceConfig } from './load-workspace-config';
import { EventBridge } from './adapters/event-bridge';
import { WebConfirmAdapter } from './adapters/web-confirm';
import { ensureRepoClone } from './repo-clone';
import type { Database } from './supabase/types';

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
 */
export async function runOrchestrator(
  supabase: SupabaseClient<Database>,
  opts: RunOrchestratorOpts,
): Promise<void> {
  const { flowId, workspaceId, issueNumber, mode, githubToken, confirmPolicy, initLifecycle } = opts;
  const eventBridge = new EventBridge(flowId, supabase);
  const confirmAdapter = new WebConfirmAdapter(flowId, supabase);

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

    if (initLifecycle) eventBridge.lifecycle(initLifecycle);

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
      onEvent: (msg) => eventBridge.lifecycle(msg),
      onAgentEvent: (evt) => eventBridge.agent(evt),
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

    await store.save();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    eventBridge.lifecycle(`FATAL: ${message}`);
    await supabase
      .from('flows')
      .update({ status: 'failed', outcome: { status: 'failed', reason: message } as any })
      .eq('id', flowId);
  } finally {
    setTimeout(() => eventBridge.dispose(), 3000);
  }
}
