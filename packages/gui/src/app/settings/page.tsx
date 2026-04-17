import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SettingsForm } from './settings-form';

async function loadWorkspaceConfig(workspaceId: string): Promise<Record<string, unknown>> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('workspaces')
    .select('config')
    .eq('id', workspaceId)
    .single();
  return (data?.config as Record<string, unknown>) ?? {};
}

export default async function SettingsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
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

  const config = await loadWorkspaceConfig(workspace.id);
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
      <SettingsForm config={config} readOnly={!isAdmin} />
    </div>
  );
}
