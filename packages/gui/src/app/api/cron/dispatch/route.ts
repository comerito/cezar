import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { executeWorkflowJob } from '@/lib/execute-workflow-job';
import type { CiFollowupInput } from '@cezar/core';
import type { Database } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// How many queued jobs to claim per tick. Each claimed job's execution is
// fire-and-forget (it outlives this response) — keep this small so a tick
// doesn't spin up too many heavyweight agent sessions at once.
const DISPATCH_BATCH = Number(process.env.CEZAR_DISPATCH_BATCH) || 3;

// How stale a 'claimed'/'running' job must be before the watchdog re-queues it.
const STALE_MINUTES = Number(process.env.CEZAR_DISPATCH_STALE_MINUTES) || 15;

// How stale a self-hosted runner's heartbeat must be before we mark it offline
// and re-queue the jobs it was holding (Phase 4a). Runners heartbeat ~every
// 10s, so 3min is a generous "it's dead" threshold.
const OFFLINE_RUNNER_MINUTES = Number(process.env.CEZAR_RUNNER_OFFLINE_MINUTES) || 3;

type JobRow = Database['public']['Tables']['jobs']['Row'];

/**
 * Phase 3c dispatcher (docs §3.7). Each invocation:
 *   1. re-queues stalled jobs (watchdog),
 *   2. claims up to DISPATCH_BATCH queued jobs,
 *   3. marks each 'running' and fire-and-forgets its workflow execution.
 *
 * This mirrors the existing `issue-fix` cron's fire-and-forget pattern and
 * inherits the same serverless-duration caveat — a long agent run can outlive
 * the function. The watchdog above is the safety net; the proper long-running
 * runner is Phase 4 (`packages/runner`).
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

  // ── watchdog ──
  let requeued = 0;
  {
    const { data, error } = await supabase.rpc('requeue_stalled_jobs', { p_stale_minutes: STALE_MINUTES });
    if (error) console.error('[dispatch] requeue_stalled_jobs failed:', error.message);
    else requeued = typeof data === 'number' ? data : 0;
  }
  // Phase 4a — also re-queue jobs orphaned by a dead self-hosted runner (and
  // mark those runners offline). `claim_next_job` now only returns cron-eligible
  // jobs (required_backend null/anthropic-api) — see migration 0010.
  {
    const { data, error } = await supabase.rpc('requeue_jobs_for_offline_runners', { p_stale_minutes: OFFLINE_RUNNER_MINUTES });
    if (error) console.error('[dispatch] requeue_jobs_for_offline_runners failed:', error.message);
    else requeued += typeof data === 'number' ? data : 0;
  }

  // ── claim ──
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_job', { p_limit: DISPATCH_BATCH });
  if (claimErr) {
    console.error('[dispatch] claim_next_job failed:', claimErr.message);
    return NextResponse.json({ error: claimErr.message, requeued }, { status: 500 });
  }
  const jobs = (claimed ?? []) as JobRow[];
  if (jobs.length === 0) return NextResponse.json({ claimed: 0, requeued });

  let dispatched = 0;
  for (const job of jobs) {
    // Mark running before kicking off the (fire-and-forget) execution.
    const { error: runErr } = await supabase
      .from('jobs')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'claimed');
    if (runErr) {
      console.error(`[dispatch] could not mark job ${job.id} running:`, runErr.message);
      continue;
    }

    const payload = (job.payload ?? {}) as { ciFollowup?: CiFollowupInput };
    void executeWorkflowJob(supabase, {
      workspaceId: job.workspace_id,
      repo: job.repo,
      workflow: job.kind,
      issueNumber: job.issue_number ?? undefined,
      prNumber: job.pr_number ?? undefined,
      jobId: job.id,
      ciFollowupSeed: payload.ciFollowup,
    }).catch((err) => {
      console.error(`[dispatch] job ${job.id} crashed:`, err);
    });
    dispatched += 1;
  }

  return NextResponse.json({ claimed: dispatched, requeued });
}
