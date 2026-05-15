import { NextResponse } from 'next/server';
import { authRunner } from '../_auth';
import type { RunnerStatus } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface HeartbeatBody {
  status?: RunnerStatus;
  currentJobIds?: string[];
}

/**
 * POST /api/runner/heartbeat  { status?, currentJobIds? }
 *
 * Refreshes the runner's `last_heartbeat_at`/`status` and tells it which of its
 * jobs/runs the operator has asked to cancel/pause (the runner has no other
 * channel for that).
 */
export async function POST(req: Request) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;

  let body: HeartbeatBody = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const status: RunnerStatus = body.status ?? 'online';

  await admin.from('runners').update({ last_heartbeat_at: new Date().toISOString(), status, updated_at: new Date().toISOString() }).eq('id', runner.id);

  // Jobs this runner holds that have been cancelled.
  const { data: cancelledJobs } = await admin
    .from('jobs')
    .select('id')
    .eq('claimed_by_runner', runner.id)
    .in('status', ['cancelled']);
  const cancelJobIds = (cancelledJobs ?? []).map((j) => j.id);

  // Workflow runs driven by this runner's jobs with pause_requested set.
  let pauseRunIds: string[] = [];
  {
    const { data: activeJobs } = await admin
      .from('jobs')
      .select('id')
      .eq('claimed_by_runner', runner.id)
      .in('status', ['claimed', 'running']);
    const jobIds = (activeJobs ?? []).map((j) => j.id);
    if (jobIds.length > 0) {
      const { data: runs } = await admin
        .from('workflow_runs')
        .select('id')
        .in('job_id', jobIds)
        .eq('pause_requested', true);
      pauseRunIds = (runs ?? []).map((r) => r.id);
    }
  }

  return NextResponse.json({ ok: true, cancelJobIds, pauseRunIds });
}
