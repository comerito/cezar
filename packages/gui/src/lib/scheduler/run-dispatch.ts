// Pure-function body of the /api/cron/dispatch route — shared between the HTTP
// handler (auth-gated) and the in-process scheduler (trusted, no auth). Same
// fire-and-forget semantics as before: each claimed job's workflow execution
// outlives this call.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CiFollowupInput } from '@cezar/core';
import { executeWorkflowJob } from '@/lib/execute-workflow-job';
import type { Database } from '@/lib/supabase/types';

type JobRow = Database['public']['Tables']['jobs']['Row'];

export interface DispatchResult {
  claimed: number;
  requeued: number;
  error?: string;
}

export async function runDispatch(supabase: SupabaseClient<Database>): Promise<DispatchResult> {
  const DISPATCH_BATCH = Number(process.env.CEZAR_DISPATCH_BATCH) || 3;
  const STALE_MINUTES = Number(process.env.CEZAR_DISPATCH_STALE_MINUTES) || 15;
  const OFFLINE_RUNNER_MINUTES = Number(process.env.CEZAR_RUNNER_OFFLINE_MINUTES) || 3;

  // ── watchdog ──
  let requeued = 0;
  {
    const { data, error } = await supabase.rpc('requeue_stalled_jobs', { p_stale_minutes: STALE_MINUTES });
    if (error) console.error('[dispatch] requeue_stalled_jobs failed:', error.message);
    else requeued = typeof data === 'number' ? data : 0;
  }
  {
    const { data, error } = await supabase.rpc('requeue_jobs_for_offline_runners', { p_stale_minutes: OFFLINE_RUNNER_MINUTES });
    if (error) console.error('[dispatch] requeue_jobs_for_offline_runners failed:', error.message);
    else requeued += typeof data === 'number' ? data : 0;
  }

  // ── claim ──
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_job', { p_limit: DISPATCH_BATCH });
  if (claimErr) {
    console.error('[dispatch] claim_next_job failed:', claimErr.message);
    return { claimed: 0, requeued, error: claimErr.message };
  }
  const jobs = (claimed ?? []) as JobRow[];
  if (jobs.length === 0) return { claimed: 0, requeued };

  let dispatched = 0;
  for (const job of jobs) {
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

  return { claimed: dispatched, requeued };
}
