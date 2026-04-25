'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolvePendingConfirmation, cancelPendingConfirmation } from '@/lib/adapters/web-confirm';
import { runOrchestrator } from '@/lib/run-orchestrator';

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
  runOrchestrator(supabase, {
    flowId: flow.id,
    workspaceId: workspace.id,
    issueNumber,
    mode,
    githubToken,
    confirmPolicy: 'interactive',
  }).catch((err) => {
    console.error(`[flow ${flow.id}] orchestrator crashed:`, err);
  });

  redirect(`/flows/cockpit/${flow.id}`);
}

export async function activateNotifiedCandidate(issueNumber: number) {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const workspace = await getActiveWorkspace();
  if (!workspace) throw new Error('No workspace selected');

  const supabase = createSupabaseAdminClient();

  // Atomic claim: only succeed if the candidate is still in `notified` state.
  // Two users racing the same button — exactly one wins.
  const { data: claimed, error: claimErr } = await supabase
    .from('issue_autofix_candidates')
    .update({ status: 'dispatched', last_checked_at: new Date().toISOString() })
    .eq('workspace_id', workspace.id)
    .eq('issue_number', issueNumber)
    .eq('status', 'notified')
    .select('id')
    .maybeSingle();

  if (claimErr) throw new Error(`Claim failed: ${claimErr.message}`);
  if (!claimed) throw new Error('Candidate not in notified state');

  const { data: flow, error: flowErr } = await supabase
    .from('flows')
    .insert({
      workspace_id: workspace.id,
      actor_id: user.id,
      issue_number: issueNumber,
      status: 'running',
      mode: 'apply',
      attempts: [],
    })
    .select('id')
    .single();

  if (flowErr || !flow) throw new Error(`Failed to create flow: ${flowErr?.message ?? 'no row'}`);

  await supabase
    .from('issue_autofix_candidates')
    .update({ dispatched_flow_id: flow.id, last_checked_at: new Date().toISOString() })
    .eq('id', claimed.id);

  const githubToken = user.githubToken || process.env.GITHUB_TOKEN || '';
  runOrchestrator(supabase, {
    flowId: flow.id,
    workspaceId: workspace.id,
    issueNumber,
    mode: 'apply',
    githubToken,
    confirmPolicy: 'interactive',
  }).catch((err) => {
    console.error(`[flow ${flow.id}] orchestrator crashed:`, err);
  });

  redirect(`/flows/cockpit/${flow.id}`);
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
