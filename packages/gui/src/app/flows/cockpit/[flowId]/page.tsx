import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { CockpitShell } from './cockpit-shell';
import type { Database } from '@/lib/supabase/types';

type FlowRow = Database['public']['Tables']['flows']['Row'];
type EventRow = Database['public']['Tables']['flow_events']['Row'];

async function loadFlow(flowId: string) {
  const supabase = createSupabaseAdminClient();
  const [{ data: flow }, { data: events }] = await Promise.all([
    supabase.from('flows').select('*').eq('id', flowId).single(),
    supabase
      .from('flow_events')
      .select('*')
      .eq('flow_id', flowId)
      .order('created_at', { ascending: true }),
  ]);
  if (!flow) return null;

  let tokenBudget = 250_000;
  try {
    const config = await loadWorkspaceConfig(flow.workspace_id, supabase);
    tokenBudget = config.autofix.tokenBudgetPerAttempt;
  } catch {}

  return { flow, events: events ?? [], tokenBudget };
}

export default async function CockpitPage({ params }: { params: Promise<{ flowId: string }> }) {
  const { flowId } = await params;
  const data = await loadFlow(flowId);

  if (!data) {
    return (
      <div className="flex items-center justify-center py-32 text-fg-muted">
        Flow not found.
      </div>
    );
  }

  return (
    <CockpitShell
      flow={data.flow}
      initialEvents={data.events}
      tokenBudgetLimit={data.tokenBudget}
    />
  );
}
