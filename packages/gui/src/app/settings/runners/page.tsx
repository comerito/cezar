import Link from 'next/link';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { RunnerKind, RunnerStatus } from '@/lib/supabase/types';
import { RunnersSection, type RunnerRowView, type RunnerDisplayStatus } from './runners-section';

interface RunnerDbRow {
  id: string;
  workspace_id: string | null;
  name: string;
  kind: RunnerKind;
  backends: string[];
  status: RunnerStatus;
  last_heartbeat_at: string | null;
  created_at: string;
}

const ONLINE_WINDOW_MS = 2 * 60_000;
const STALE_WINDOW_MS = 30 * 60_000;

/** Derive a display status from the last heartbeat (independent of the stored
 * `status` enum, which lags between heartbeats). */
function displayStatus(lastHeartbeatAt: string | null): RunnerDisplayStatus {
  if (!lastHeartbeatAt) return 'offline';
  const age = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (Number.isNaN(age)) return 'offline';
  if (age <= ONLINE_WINDOW_MS) return 'online';
  if (age <= STALE_WINDOW_MS) return 'stale';
  return 'offline';
}

function toView(r: RunnerDbRow): RunnerRowView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    backends: Array.isArray(r.backends) ? r.backends : [],
    displayStatus: displayStatus(r.last_heartbeat_at),
    lastHeartbeatAt: r.last_heartbeat_at,
    createdAt: r.created_at,
    managed: r.workspace_id == null,
  };
}

export default async function RunnersPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <header className="mb-6 border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">Runners</h1>
        </header>
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No workspace selected. Create one first.
        </div>
      </div>
    );
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: ownRows }, { data: managedRows }] = await Promise.all([
    supabase
      .from('runners')
      .select('id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: true })
      .returns<RunnerDbRow[]>(),
    supabase
      .from('runners')
      .select('id, workspace_id, name, kind, backends, status, last_heartbeat_at, created_at')
      .is('workspace_id', null)
      .order('created_at', { ascending: true })
      .returns<RunnerDbRow[]>(),
  ]);

  const isAdmin = workspace.role === 'admin';
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') ||
    '';

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <div className="flex items-center gap-3 text-sm text-fg-subtle">
          <Link href="/settings" className="hover:text-fg">Settings</Link>
          <span>/</span>
          <span className="text-fg">Runners</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Runners</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Self-hosted runners pick up <code className="text-fg">claude-cli</code> /{' '}
          <code className="text-fg">codex-cli</code> jobs on your own infra under your own CLI login.
          The managed cloud runner handles <code className="text-fg">anthropic-api</code> jobs.{' '}
          See <code className="text-fg">docs/runner-setup.md</code> for the full setup.
          {!isAdmin && <span className="ml-2 text-fg-subtle">(read-only — admin required to register or revoke)</span>}
        </p>
      </header>

      <RunnersSection
        ownRunners={(ownRows ?? []).map(toView)}
        managedRunners={(managedRows ?? []).map(toView)}
        isAdmin={isAdmin}
        appUrl={appUrl}
      />
    </div>
  );
}
