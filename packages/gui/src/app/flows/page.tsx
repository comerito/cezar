import Link from 'next/link';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database, FlowStatus } from '@/lib/supabase/types';

type FlowRow = Database['public']['Tables']['flows']['Row'];

async function loadFlows(workspaceId: string): Promise<FlowRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('flows')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(50);
  return data ?? [];
}

export default async function FlowsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <header className="mb-6 border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">My Flows</h1>
        </header>
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No workspace selected.
        </div>
      </div>
    );
  }

  const flows = await loadFlows(workspace.id);

  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">My Flows</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Autofix runs you initiated — {flows.length} flows
        </p>
      </header>

      {flows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No flows yet. Trigger an autofix from the Issues page.
        </div>
      ) : (
        <div className="space-y-2">
          {flows.map((flow) => (
            <FlowCard key={flow.id} flow={flow} />
          ))}
        </div>
      )}
    </div>
  );
}

function FlowCard({ flow }: { flow: FlowRow }) {
  const outcome = flow.outcome as any;
  const isActive = flow.status === 'running' || flow.status === 'pending';

  return (
    <Link
      href={`/flows/cockpit/${flow.id}`}
      className="flex items-center justify-between rounded-lg border border-border bg-bg-elevated p-4 transition-colors hover:border-accent/40"
    >
      <div className="flex items-center gap-4">
        <div className="text-sm font-medium text-fg">Issue #{flow.issue_number}</div>
        <StatusBadge status={flow.status} />
        <span className="text-xs text-fg-subtle">{flow.mode}</span>
      </div>
      <div className="flex items-center gap-4 text-xs text-fg-muted">
        {outcome?.prUrl && (
          <span className="text-accent">PR opened</span>
        )}
        {outcome?.reason && !outcome?.prUrl && (
          <span className="max-w-[200px] truncate">{outcome.reason}</span>
        )}
        <span>{new Date(flow.created_at).toLocaleString()}</span>
        {isActive && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
      </div>
    </Link>
  );
}

function StatusBadge({ status }: { status: FlowStatus }) {
  const colors: Record<string, string> = {
    pending: 'bg-fg-subtle/20 text-fg-subtle',
    running: 'bg-accent/20 text-accent',
    succeeded: 'bg-accent/20 text-accent',
    failed: 'bg-danger/20 text-danger',
    skipped: 'bg-fg-subtle/20 text-fg-subtle',
    'pr-opened': 'bg-accent/20 text-accent',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${colors[status] ?? ''}`}>
      {status}
    </span>
  );
}
