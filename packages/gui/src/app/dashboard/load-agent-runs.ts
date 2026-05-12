import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { Database, DbWorkflowRunStatus } from '@/lib/supabase/types';

export interface AgentRunStats {
  running: number;
  paused: number;
  queued: number;
  failedLast24h: number;
  recentRuns: Array<{
    id: string;
    workflow: string;
    issue_number: number | null;
    pr_number: number | null;
    status: DbWorkflowRunStatus;
    started_at: string;
  }>;
}

/**
 * Counts for the dashboard "Agent runs" card. `queued` blends queued
 * workflow_runs + queued jobs (work that hasn't materialised into a run yet).
 * Uses the admin client (the dashboard already authorized the workspace member).
 */
export async function loadAgentRunStats(
  workspaceId: string,
  supabase?: SupabaseClient<Database>,
): Promise<AgentRunStats | null> {
  try {
    const sb = supabase ?? createSupabaseAdminClient();
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [
      { count: running },
      { count: paused },
      { count: queuedRuns },
      { count: queuedJobs },
      { count: failedLast24h },
      { data: recent },
    ] = await Promise.all([
      sb.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'running'),
      sb.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'paused'),
      sb.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'queued'),
      sb.from('jobs').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'queued'),
      sb
        .from('workflow_runs')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'failed')
        .gte('created_at', since24h),
      sb
        .from('workflow_runs')
        .select('id, workflow, issue_number, pr_number, status, started_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);

    return {
      running: running ?? 0,
      paused: paused ?? 0,
      queued: (queuedRuns ?? 0) + (queuedJobs ?? 0),
      failedLast24h: failedLast24h ?? 0,
      recentRuns: (recent ?? []).map((r) => ({
        id: r.id,
        workflow: r.workflow,
        issue_number: r.issue_number,
        pr_number: r.pr_number,
        status: r.status as DbWorkflowRunStatus,
        started_at: r.started_at,
      })),
    };
  } catch {
    return null;
  }
}
