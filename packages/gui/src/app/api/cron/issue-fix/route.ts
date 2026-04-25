import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { runOrchestrator } from '@/lib/run-orchestrator';
import type { IssueAutofixCandidateStatus, IssueAutofixMode } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Orchestrator runs are heavyweight — agent sessions per issue can take many
// minutes. Mirrors ci-fix's MAX_FLOWS_PER_TICK = 1 spirit; we allow a small
// batch since the orchestrator launches are fire-and-forget.
const MAX_CANDIDATES_PER_TICK = 5;

type Workspace = {
  id: string;
  issue_autofix_mode: IssueAutofixMode;
};

type Candidate = {
  id: string;
  workspace_id: string;
  issue_number: number;
  status: IssueAutofixCandidateStatus;
};

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();

  const { data: workspaces, error: wsErr } = await supabase
    .from('workspaces')
    .select('id, issue_autofix_mode')
    .neq('issue_autofix_mode', 'off');

  if (wsErr) {
    console.error('[issue-fix] workspace query failed:', wsErr.message);
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ dispatched: 0 });
  }

  const modeByWs = new Map<string, IssueAutofixMode>(
    (workspaces as Workspace[]).map(w => [w.id, w.issue_autofix_mode]),
  );
  const workspaceIds = Array.from(modeByWs.keys());

  const { data: unmatched, error: candErr } = await supabase
    .from('issue_autofix_candidates')
    .select('id, workspace_id, issue_number, status')
    .in('workspace_id', workspaceIds)
    .eq('status', 'unmatched')
    .limit(MAX_CANDIDATES_PER_TICK);

  if (candErr) {
    console.error('[issue-fix] candidate query failed:', candErr.message);
    return NextResponse.json({ error: candErr.message }, { status: 500 });
  }

  if (!unmatched || unmatched.length === 0) {
    return NextResponse.json({ dispatched: 0 });
  }

  let notified = 0;
  let dispatched = 0;
  const errors: Array<{ candidateId: string; error: string }> = [];

  for (const c of unmatched as Candidate[]) {
    const mode = modeByWs.get(c.workspace_id);
    if (!mode || mode === 'off') continue;

    try {
      if (mode === 'notify') {
        const { error: updErr } = await supabase
          .from('issue_autofix_candidates')
          .update({ status: 'notified', last_checked_at: new Date().toISOString() })
          .eq('id', c.id)
          .eq('status', 'unmatched');
        if (updErr) throw new Error(`notify update failed: ${updErr.message}`);
        notified += 1;
        continue;
      }

      // mode === 'autonomous' — atomic claim then dispatch.
      const { data: claimed, error: claimErr } = await supabase
        .from('issue_autofix_candidates')
        .update({ status: 'dispatched', last_checked_at: new Date().toISOString() })
        .eq('id', c.id)
        .eq('status', 'unmatched')
        .select('id');
      if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
      if (!claimed || claimed.length === 0) continue;

      const { token, adminUserId } = await resolveWorkspaceToken(c.workspace_id, supabase);
      if (!token || !adminUserId) {
        // No usable token / admin: leave the candidate marked dispatched but
        // record the failure on a flow so it surfaces in Phase 1c. We need an
        // actor_id to insert a flow row, so without an admin we can't even
        // record the failure — log and move on.
        if (!adminUserId) {
          console.error(`[issue-fix] candidate ${c.id}: no admin user found; cannot dispatch`);
          errors.push({ candidateId: c.id, error: 'no admin user' });
          continue;
        }
        // Have an admin but no token — record a failed flow.
        const { data: failedFlow } = await supabase
          .from('flows')
          .insert({
            workspace_id: c.workspace_id,
            actor_id: adminUserId,
            issue_number: c.issue_number,
            status: 'failed',
            mode: 'apply',
            attempts: [],
            outcome: { status: 'failed', reason: 'no github token available' } as any,
          } as any)
          .select('id')
          .single();
        if (failedFlow) {
          await supabase
            .from('issue_autofix_candidates')
            .update({ dispatched_flow_id: failedFlow.id })
            .eq('id', c.id);
        }
        errors.push({ candidateId: c.id, error: 'no github token' });
        continue;
      }

      const { data: flow, error: flowErr } = await supabase
        .from('flows')
        .insert({
          workspace_id: c.workspace_id,
          actor_id: adminUserId,
          issue_number: c.issue_number,
          status: 'running',
          mode: 'apply',
          attempts: [],
        } as any)
        .select('id')
        .single();
      if (flowErr || !flow) throw new Error(`flow insert failed: ${flowErr?.message ?? 'no row'}`);

      await supabase
        .from('issue_autofix_candidates')
        .update({ dispatched_flow_id: flow.id, last_checked_at: new Date().toISOString() })
        .eq('id', c.id);

      // Fire-and-forget — orchestrator outlives this response. On throw it
      // marks the flow failed; we intentionally do not revert the candidate.
      runOrchestrator(supabase, {
        flowId: flow.id,
        workspaceId: c.workspace_id,
        issueNumber: c.issue_number,
        mode: 'apply',
        githubToken: token,
        confirmPolicy: 'autonomous',
        initLifecycle: 'AUTONOMOUS — auto-proceeding from candidate',
      }).catch((err) => {
        console.error(`[issue-fix] flow ${flow.id} crashed:`, err);
      });

      dispatched += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[issue-fix] candidate ${c.id} failed:`, msg);
      errors.push({ candidateId: c.id, error: msg });
    }
  }

  return NextResponse.json({ dispatched, notified, errors });
}

// Mirrors the helper in api/cron/issue-sync/route.ts. Duplicated intentionally
// to keep this route self-contained; if a third call site appears, lift it.
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ token: string | null; adminUserId: string | null }> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');

  const adminUserId = admins?.[0]?.user_id ?? null;

  if (admins && admins.length > 0) {
    const ids = admins.map(a => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return { token, adminUserId };
  }

  return { token: process.env.GITHUB_TOKEN || null, adminUserId };
}
