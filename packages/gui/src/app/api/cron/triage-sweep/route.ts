import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// How many never-triaged open issues to enqueue per workspace per tick. Small —
// the webhook is the primary trigger; this is the catch-up for installs without
// webhooks / missed deliveries.
const SWEEP_BATCH = Number(process.env.CEZAR_TRIAGE_SWEEP_BATCH) || 10;
const MAX_WORKSPACES_PER_TICK = 25;

type WorkspaceRow = { id: string; repo_owner: string; repo_name: string };

/**
 * Phase 5 poll fallback (docs §3.7). For each workspace with
 * `auto_triage_enabled`, find open issues that have never been triaged (no
 * `triage` job in queued/claimed/running/done and no `triage` workflow run) and
 * enqueue a (deduped) `triage` job for the most recent N of them.
 */
export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name')
    .eq('auto_triage_enabled', true)
    .limit(MAX_WORKSPACES_PER_TICK);
  if (error) {
    console.error('[triage-sweep] workspace query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!workspaces || workspaces.length === 0) return NextResponse.json({ enqueued: 0, workspaces: 0 });

  let totalEnqueued = 0;
  for (const ws of workspaces as WorkspaceRow[]) {
    try {
      totalEnqueued += await sweepOne(ws, supabase);
    } catch (err) {
      console.error(`[triage-sweep] workspace ${ws.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return NextResponse.json({ enqueued: totalEnqueued, workspaces: workspaces.length });
}

async function sweepOne(ws: WorkspaceRow, supabase: ReturnType<typeof createSupabaseAdminClient>): Promise<number> {
  const repoSlug = `${ws.repo_owner}/${ws.repo_name}`;

  // Open issues, most recent first — only need a window a bit wider than the batch
  // (older untriaged issues stay untriaged but trickle in over many ticks).
  const { data: issues } = await supabase
    .from('issues')
    .select('number, updated_at')
    .eq('workspace_id', ws.id)
    .eq('state', 'open')
    .order('updated_at', { ascending: false })
    .limit(SWEEP_BATCH * 10);
  if (!issues || issues.length === 0) return 0;

  // Which of these have ever been triaged (a triage job or run)?
  const [{ data: jobRows }, { data: runRows }] = await Promise.all([
    supabase
      .from('jobs')
      .select('issue_number')
      .eq('workspace_id', ws.id)
      .eq('kind', 'triage')
      .in('status', ['queued', 'claimed', 'running', 'done']),
    supabase
      .from('workflow_runs')
      .select('issue_number')
      .eq('workspace_id', ws.id)
      .eq('workflow', 'triage'),
  ]);
  const triaged = new Set<number>();
  for (const r of jobRows ?? []) if (r.issue_number != null) triaged.add(r.issue_number);
  for (const r of runRows ?? []) if (r.issue_number != null) triaged.add(r.issue_number);

  const untriaged = issues.filter((i) => !triaged.has(i.number)).slice(0, SWEEP_BATCH);
  if (untriaged.length === 0) return 0;

  let enqueued = 0;
  for (const issue of untriaged) {
    // dedupe (paranoia — the `triaged` set already covers queued/claimed/running).
    const { data: open } = await supabase
      .from('jobs')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('kind', 'triage')
      .eq('issue_number', issue.number)
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1);
    if (open && open.length > 0) continue;
    const { error } = await supabase.from('jobs').insert({
      workspace_id: ws.id,
      repo: repoSlug,
      kind: 'triage',
      issue_number: issue.number,
      pr_number: null,
      priority: 5,
      status: 'queued',
      max_attempts: 1,
      payload: { trigger: 'sweep' },
    });
    if (error) {
      console.error(`[triage-sweep] enqueue failed for ws ${ws.id} #${issue.number}:`, error.message);
      continue;
    }
    enqueued++;
  }
  return enqueued;
}
