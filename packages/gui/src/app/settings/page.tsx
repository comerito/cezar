import { getActiveWorkspace } from '@/lib/workspace';
import { getSessionUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SettingsForm } from './settings-form';
import { TeamSection } from './team-section';
import type { WorkspaceRole } from '@/lib/supabase/types';

async function loadWorkspaceConfig(workspaceId: string): Promise<Record<string, unknown>> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspaces')
    .select('config')
    .eq('id', workspaceId)
    .single();
  return (data?.config as Record<string, unknown>) ?? {};
}

interface MemberRow {
  user_id: string;
  role: WorkspaceRole;
}

async function loadMembers(workspaceId: string) {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspace_members')
    .select('user_id, role')
    .eq('workspace_id', workspaceId);

  if (!data) return [];

  const { data: authUsers } = await supabase.auth.admin.listUsers();
  const userMap = new Map(
    (authUsers?.users ?? []).map((u) => [u.id, {
      email: u.email ?? '',
      name: u.user_metadata?.full_name ?? u.user_metadata?.user_name ?? u.email ?? '',
      avatarUrl: u.user_metadata?.avatar_url ?? '',
    }]),
  );

  return (data as MemberRow[]).map((m) => {
    const info = userMap.get(m.user_id);
    return {
      userId: m.user_id,
      email: info?.email ?? '',
      name: info?.name ?? m.user_id.slice(0, 8),
      avatarUrl: info?.avatarUrl ?? '',
      role: m.role,
    };
  });
}

export default async function SettingsPage() {
  const [workspace, user] = await Promise.all([getActiveWorkspace(), getSessionUser()]);

  if (!workspace || !user) {
    return (
      <div className="px-8 py-6">
        <header className="mb-6 border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        </header>
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
          No workspace selected. Create one first.
        </div>
      </div>
    );
  }

  const [config, members] = await Promise.all([
    loadWorkspaceConfig(workspace.id),
    loadMembers(workspace.id),
  ]);
  const isAdmin = workspace.role === 'admin';

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {workspace.name} — {workspace.repoOwner}/{workspace.repoName}
          {!isAdmin && <span className="ml-2 text-fg-subtle">(read-only — admin required to edit)</span>}
        </p>
      </header>

      <div className="space-y-12">
        <section>
          <h2 className="mb-4 text-lg font-semibold tracking-tight">Team</h2>
          <TeamSection members={members} isAdmin={isAdmin} currentUserId={user.id} />
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold tracking-tight">Configuration</h2>
          <SettingsForm config={config} readOnly={!isAdmin} />
        </section>
      </div>
    </div>
  );
}
