import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import type { Database, FlowStatus } from '@/lib/supabase/types';

type FlowRow = Database['public']['Tables']['flows']['Row'];
type EventRow = Database['public']['Tables']['flow_events']['Row'];

interface ActivityItem {
  id: string;
  type: 'flow_created' | 'flow_completed' | 'lifecycle';
  message: string;
  status?: FlowStatus;
  issueNumber?: number;
  flowId?: string;
  timestamp: string;
}

async function loadActivity(workspaceId: string): Promise<ActivityItem[]> {
  const supabase = await createSupabaseServerClient();

  const [{ data: flows }, { data: events }] = await Promise.all([
    supabase
      .from('flows')
      .select('id, issue_number, status, mode, outcome, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(50),
    supabase
      .from('flow_events')
      .select('id, flow_id, type, payload, created_at')
      .eq('type', 'lifecycle')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const items: ActivityItem[] = [];

  for (const f of flows ?? []) {
    const outcome = f.outcome as any;
    const isTerminal = ['succeeded', 'failed', 'skipped', 'pr-opened'].includes(f.status);

    items.push({
      id: `flow-${f.id}`,
      type: 'flow_created',
      message: `Autofix started for #${f.issue_number} (${f.mode})`,
      status: f.status,
      issueNumber: f.issue_number,
      flowId: f.id,
      timestamp: f.created_at,
    });

    if (isTerminal) {
      const msg = f.status === 'pr-opened'
        ? `PR opened for #${f.issue_number}${outcome?.prUrl ? ` — ${outcome.prUrl}` : ''}`
        : f.status === 'failed'
          ? `Autofix failed for #${f.issue_number}: ${outcome?.reason ?? 'unknown'}`
          : `Autofix ${f.status} for #${f.issue_number}`;

      items.push({
        id: `flow-done-${f.id}`,
        type: 'flow_completed',
        message: msg,
        status: f.status,
        issueNumber: f.issue_number,
        flowId: f.id,
        timestamp: f.updated_at,
      });
    }
  }

  for (const e of events ?? []) {
    const payload = e.payload as any;
    const msg = payload?.message;
    if (!msg || typeof msg !== 'string') continue;
    if (msg.startsWith('[#')) {
      items.push({
        id: e.id,
        type: 'lifecycle',
        message: msg,
        flowId: e.flow_id,
        timestamp: e.created_at,
      });
    }
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return items.slice(0, 100);
}

export default async function ActivityPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-2 text-sm text-fg-muted">No workspace selected.</p>
      </div>
    );
  }

  const items = await loadActivity(workspace.id);

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Recent events — {workspace.repoOwner}/{workspace.repoName}
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No activity yet. Sync issues or run an autofix to generate events.
        </div>
      ) : (
        <div className="space-y-0">
          {items.map((item, idx) => (
            <div key={item.id} className="flex gap-4 border-l-2 border-border py-2 pl-4">
              <div className="w-16 shrink-0 text-right text-[10px] text-fg-subtle">
                {formatTime(item.timestamp)}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <TypeIcon type={item.type} status={item.status} />
                  <span className="text-xs text-fg">{item.message}</span>
                </div>
                {item.flowId && (
                  <a
                    href={`/flows/cockpit/${item.flowId}`}
                    className="mt-0.5 inline-block text-[10px] text-fg-subtle hover:text-accent"
                  >
                    view cockpit
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TypeIcon({ type, status }: { type: string; status?: FlowStatus }) {
  if (type === 'flow_completed' && status === 'pr-opened') return <span className="text-xs text-accent">PR</span>;
  if (type === 'flow_completed' && status === 'failed') return <span className="text-xs text-danger">✗</span>;
  if (type === 'flow_completed') return <span className="text-xs text-accent">✓</span>;
  if (type === 'flow_created') return <span className="text-xs text-fg-muted">▸</span>;
  return <span className="text-xs text-fg-subtle">·</span>;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
