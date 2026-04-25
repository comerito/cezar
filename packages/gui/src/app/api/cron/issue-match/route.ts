import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { IssueAutofixCandidateStatus, IssueAutofixMode } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cap per-tick work — matching is cheap (all local DB), but bound it anyway
// so a backlog can't blow the cron timeout.
const MAX_CANDIDATES_PER_TICK = 50;

type Workspace = {
  id: string;
  issue_autofix_mode: IssueAutofixMode;
};

type Candidate = {
  id: string;
  workspace_id: string;
  issue_number: number;
  status: IssueAutofixCandidateStatus;
  matched_pr_number: number | null;
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
    console.error('[issue-match] workspace query failed:', wsErr.message);
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ matched: 0 });
  }

  const workspaceIds = (workspaces as Workspace[]).map(w => w.id);

  // Pull pending candidates across all eligible workspaces, capped globally.
  const { data: pending, error: pendErr } = await supabase
    .from('issue_autofix_candidates')
    .select('id, workspace_id, issue_number, status, matched_pr_number')
    .in('workspace_id', workspaceIds)
    .eq('status', 'pending_match')
    .limit(MAX_CANDIDATES_PER_TICK);

  if (pendErr) {
    console.error('[issue-match] candidate query failed:', pendErr.message);
    return NextResponse.json({ error: pendErr.message }, { status: 500 });
  }

  // Re-evaluation pass: matched_to_pr rows whose PR is no longer open.
  const { data: matched, error: matchedErr } = await supabase
    .from('issue_autofix_candidates')
    .select('id, workspace_id, issue_number, status, matched_pr_number')
    .in('workspace_id', workspaceIds)
    .eq('status', 'matched_to_pr');

  if (matchedErr) {
    console.error('[issue-match] matched query failed:', matchedErr.message);
    return NextResponse.json({ error: matchedErr.message }, { status: 500 });
  }

  let revertedCount = 0;
  if (matched && matched.length > 0) {
    revertedCount = await revertStaleMatches(matched as Candidate[], supabase);
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ matched: 0, reverted: revertedCount });
  }

  const results = await Promise.all(
    (pending as Candidate[]).map(async (c) => {
      try {
        return await matchOne(c, supabase);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[issue-match] candidate ${c.id} failed:`, msg);
        return { candidateId: c.id, ok: false, error: msg };
      }
    }),
  );

  return NextResponse.json({ matched: pending.length, reverted: revertedCount, results });
}

async function matchOne(
  c: Candidate,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ candidateId: string; ok: true; status: IssueAutofixCandidateStatus }> {
  const now = new Date().toISOString();

  const { data: prs, error: prErr } = await supabase
    .from('pull_requests')
    .select('number')
    .eq('workspace_id', c.workspace_id)
    .eq('state', 'open')
    .contains('referenced_issues', [c.issue_number])
    .order('number', { ascending: true })
    .limit(1);

  if (prErr) throw new Error(`pr lookup failed: ${prErr.message}`);

  if (prs && prs.length > 0) {
    const prNumber = prs[0].number;
    const { error: updErr } = await supabase
      .from('issue_autofix_candidates')
      .update({
        status: 'matched_to_pr',
        matched_pr_number: prNumber,
        matched_reason: `PR #${prNumber} references issue (link scan)`,
        last_checked_at: now,
      })
      .eq('id', c.id);
    if (updErr) throw new Error(`candidate update failed: ${updErr.message}`);
    return { candidateId: c.id, ok: true, status: 'matched_to_pr' };
  }

  // No PR match — confirm issue is still open before marking unmatched.
  const { data: issue, error: issueErr } = await supabase
    .from('issues')
    .select('state')
    .eq('workspace_id', c.workspace_id)
    .eq('number', c.issue_number)
    .maybeSingle();

  if (issueErr) throw new Error(`issue lookup failed: ${issueErr.message}`);

  const nextStatus: IssueAutofixCandidateStatus =
    issue && issue.state === 'closed' ? 'resolved' : 'unmatched';

  const { error: updErr } = await supabase
    .from('issue_autofix_candidates')
    .update({ status: nextStatus, last_checked_at: now })
    .eq('id', c.id);
  if (updErr) throw new Error(`candidate update failed: ${updErr.message}`);

  return { candidateId: c.id, ok: true, status: nextStatus };
}

// For each matched_to_pr candidate, check if its matched PR is still open.
// If the PR row is missing or not in 'open' state, flip back to pending_match
// so the next tick redecides (could re-match to a newer PR or mark unmatched).
async function revertStaleMatches(
  candidates: Candidate[],
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<number> {
  // Group by workspace to keep the open-PR lookup scoped.
  const byWorkspace = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.matched_pr_number == null) continue;
    const list = byWorkspace.get(c.workspace_id) ?? [];
    list.push(c);
    byWorkspace.set(c.workspace_id, list);
  }

  let reverted = 0;
  for (const [workspaceId, list] of byWorkspace) {
    const prNumbers = Array.from(new Set(list.map(c => c.matched_pr_number!)));
    const { data: openPrs, error } = await supabase
      .from('pull_requests')
      .select('number')
      .eq('workspace_id', workspaceId)
      .eq('state', 'open')
      .in('number', prNumbers);

    if (error) {
      console.error(`[issue-match] open pr lookup failed (ws ${workspaceId}):`, error.message);
      continue;
    }

    const openSet = new Set((openPrs ?? []).map(p => p.number));
    const stale = list.filter(c => !openSet.has(c.matched_pr_number!));
    if (stale.length === 0) continue;

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('issue_autofix_candidates')
      .update({
        status: 'pending_match',
        matched_pr_number: null,
        matched_reason: null,
        last_checked_at: now,
      })
      .in('id', stale.map(c => c.id));

    if (updErr) {
      console.error(`[issue-match] revert update failed (ws ${workspaceId}):`, updErr.message);
      continue;
    }
    reverted += stale.length;
  }

  return reverted;
}
