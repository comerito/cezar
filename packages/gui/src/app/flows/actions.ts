'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { EventBridge } from '@/lib/adapters/event-bridge';
import { WebConfirmAdapter, resolvePendingConfirmation, cancelPendingConfirmation } from '@/lib/adapters/web-confirm';
import { ensureRepoClone } from '@/lib/repo-clone';

export async function startAutofix(issueNumber: number, mode: 'apply' | 'dry-run') {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const workspace = await getActiveWorkspace();
  if (!workspace) throw new Error('No workspace selected');

  const supabase = createSupabaseAdminClient();

  const { data: flow, error } = await supabase
    .from('flows')
    .insert({
      workspace_id: workspace.id,
      actor_id: user.id,
      issue_number: issueNumber,
      status: 'running',
      mode,
      attempts: [],
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create flow: ${error.message}`);

  const githubToken = user.githubToken || process.env.GITHUB_TOKEN || '';
  runOrchestrator(flow.id, workspace.id, issueNumber, mode, githubToken, supabase).catch((err) => {
    console.error(`[flow ${flow.id}] orchestrator crashed:`, err);
  });

  redirect(`/flows/cockpit/${flow.id}`);
}

async function runOrchestrator(
  flowId: string,
  workspaceId: string,
  issueNumber: number,
  mode: 'apply' | 'dry-run',
  githubToken: string,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
) {
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

    const orchestrator = new core.AutofixOrchestrator(store, config, github);
    const outcome = await orchestrator.processIssue(issueNumber, {
      apply: mode === 'apply',
      confirmBeforeFix: async (rootCause, issue) => {
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

export async function confirmFlowRootCause(flowId: string, decision: 'proceed' | 'skip') {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const supabase = createSupabaseAdminClient();
  const resolved = resolvePendingConfirmation(flowId, decision);

  if (!resolved) {
    // Orchestrator process is gone (server restart, crash, or pre-globalThis
    // HMR loss). Mark the flow failed so the cockpit modal closes and the
    // user can retry instead of being stuck on a stale approval card.
    await supabase
      .from('flows')
      .update({
        status: 'failed',
        outcome: {
          status: 'failed',
          reason: 'Orchestrator unreachable — likely a server restart. Retry the autofix from the issue page.',
          pendingConfirmation: null,
        } as any,
      })
      .eq('id', flowId);
    revalidatePath(`/flows/cockpit/${flowId}`);
    return;
  }

  // Clear pendingConfirmation immediately so the cockpit modal closes;
  // the orchestrator will overwrite outcome again at the end.
  await supabase
    .from('flows')
    .update({ outcome: { pendingConfirmation: null, decision } as any })
    .eq('id', flowId);
  revalidatePath(`/flows/cockpit/${flowId}`);
}

export async function cancelFlow(flowId: string) {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  cancelPendingConfirmation(flowId);
  const supabase = createSupabaseAdminClient();
  await supabase
    .from('flows')
    .update({ status: 'failed', outcome: { status: 'failed', reason: 'Cancelled by user' } as any })
    .eq('id', flowId);
  revalidatePath(`/flows/cockpit/${flowId}`);
}
