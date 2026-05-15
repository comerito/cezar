import { createSupabaseServerClient } from '@/lib/supabase/server';

export interface RepoStats {
  openIssues: number;
  closedIssues: number;
  openPRs: number;
  digested: number;
  bugs: number;
  lastSyncedAt: string | null;
}

export async function loadRepoStats(workspaceId: string): Promise<RepoStats | null> {
  try {
    const supabase = await createSupabaseServerClient();

    const [
      { count: openIssues },
      { count: closedIssues },
      { data: ws },
    ] = await Promise.all([
      supabase.from('issues').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('state', 'open'),
      supabase.from('issues').select('*', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('state', 'closed'),
      supabase.from('workspaces').select('meta').eq('id', workspaceId).single(),
    ]);

    const { count: openPrRuns } = await supabase
      .from('workflow_runs')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('workflow', 'autofix')
      .not('pr_number', 'is', null);

    const { data: issues } = await supabase
      .from('issues')
      .select('digest, analysis')
      .eq('workspace_id', workspaceId);

    const digested = (issues ?? []).filter((i: any) => i.digest != null).length;
    const bugs = (issues ?? []).filter((i: any) => i.analysis?.issueType === 'bug').length;
    const meta = (ws?.meta ?? {}) as Record<string, unknown>;

    return {
      openIssues: openIssues ?? 0,
      closedIssues: closedIssues ?? 0,
      openPRs: openPrRuns ?? 0,
      digested,
      bugs,
      lastSyncedAt: (meta.lastSyncedAt as string) ?? null,
    };
  } catch {
    return null;
  }
}
