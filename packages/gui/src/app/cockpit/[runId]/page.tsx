import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database } from '@/lib/supabase/types';
import { RunDetailShell } from './run-detail-shell';

type WorkflowRunRow = Database['public']['Tables']['workflow_runs']['Row'];
type AgentRunRow = Database['public']['Tables']['agent_runs']['Row'];
type AgentRunEventRow = Database['public']['Tables']['agent_run_events']['Row'];

export default async function CockpitRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const workspace = await getActiveWorkspace();
  if (!workspace) redirect('/workspaces');

  const supabase = await createSupabaseServerClient();
  const { data: runRow } = await supabase.from('workflow_runs').select('*').eq('id', runId).maybeSingle();
  if (!runRow || runRow.workspace_id !== workspace.id) {
    return (
      <div className="flex items-center justify-center py-32 text-fg-muted">Run not found.</div>
    );
  }

  const [{ data: steps }, { data: events }] = await Promise.all([
    supabase.from('agent_runs').select('*').eq('workflow_run_id', runId).order('started_at', { ascending: true }),
    supabase
      .from('agent_run_events')
      .select('*')
      .eq('workflow_run_id', runId)
      .order('id', { ascending: false })
      .limit(200),
  ]);

  return (
    <RunDetailShell
      run={runRow as WorkflowRunRow}
      repoOwner={workspace.repoOwner}
      repoName={workspace.repoName}
      role={workspace.role}
      initialSteps={(steps ?? []) as AgentRunRow[]}
      initialEvents={((events ?? []) as AgentRunEventRow[]).slice().reverse()}
    />
  );
}
