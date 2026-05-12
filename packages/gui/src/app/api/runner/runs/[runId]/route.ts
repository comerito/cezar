import { NextResponse } from 'next/server';
import { authRunner, runnerScopesWorkspace } from '../../_auth';
import type { Database, DbWorkflowRunStatus, JobStatus } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/runner/runs/:runId → `{ pause_requested, status }` so the runner can
 * poll for pause/cancel. (The daemon mainly learns this via the heartbeat reply;
 * this endpoint is a harmless belt-and-braces.) */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin.from('workflow_runs').select('workspace_id, pause_requested, status').eq('id', runId).maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return NextResponse.json({ pause_requested: run.pause_requested, status: run.status });
}

interface FinalizeBody {
  status: string; // 'succeeded'|'failed'|'paused'|'cancelled'|'dry-run'|'pr-opened'|'pushed'|'skipped'
  outcome?: unknown;
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  headSha?: string | null;
  tokensUsed?: number;
  reason?: string | null;
}

/** PATCH /api/runner/runs/:runId — the runner reports the final state. Updates
 * `workflow_runs` (+ `finished_at` on terminal) and the linked `jobs` row. */
export async function PATCH(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin.from('workflow_runs').select('id, job_id, workspace_id').eq('id', runId).maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: FinalizeBody;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const runStatus = mapRunStatus(body.status);
  const terminal = runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'cancelled';
  const patch: Database['public']['Tables']['workflow_runs']['Update'] = {
    status: runStatus,
    outcome: (body.outcome ?? null) as Database['public']['Tables']['workflow_runs']['Update']['outcome'],
    reason: body.reason ?? null,
    pr_url: body.prUrl ?? null,
    pr_number: body.prNumber ?? null,
    branch: body.branch ?? null,
    head_sha: body.headSha ?? null,
  };
  if (typeof body.tokensUsed === 'number') patch.tokens_used = body.tokensUsed;
  if (terminal || runStatus === 'paused') patch.finished_at = new Date().toISOString();
  await admin.from('workflow_runs').update(patch).eq('id', runId);

  if (run.job_id) {
    const jobStatus: JobStatus =
      runStatus === 'paused' ? 'queued'         // re-queue a paused run
      : runStatus === 'cancelled' ? 'cancelled'
      : runStatus === 'failed' ? 'failed'
      : 'done';
    await admin.from('jobs').update({ status: jobStatus, claimed_by_runner: null, updated_at: new Date().toISOString() }).eq('id', run.job_id);
  }

  return NextResponse.json({ ok: true });
}

function mapRunStatus(s: string): DbWorkflowRunStatus {
  switch (s) {
    case 'succeeded':
    case 'pr-opened':
    case 'pushed':
    case 'dry-run':
    case 'skipped':
      return 'succeeded';
    case 'paused': return 'paused';
    case 'cancelled': return 'cancelled';
    default: return 'failed';
  }
}
