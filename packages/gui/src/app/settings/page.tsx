import { getActiveWorkspace } from '@/lib/workspace';
import { getSessionUser } from '@/lib/auth';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SettingsForm } from './settings-form';
import { TeamSection } from './team-section';
import { AutomationSection } from './automation-section';
import { SettingsTabs, SettingsCard } from './settings-tabs';
import type { WorkspaceRole } from '@/lib/supabase/types';

async function loadWorkspaceConfig(workspaceId: string): Promise<{
  config: Record<string, unknown>;
  issueAutofixMode: 'off' | 'notify' | 'autonomous';
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  actionAutoComment: boolean;
}> {
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('workspaces')
    .select('config, issue_autofix_mode, auto_triage_enabled, autofix_enabled, separate_comment_per_step, action_auto_comment')
    .eq('id', workspaceId)
    .single();
  return {
    config: (data?.config as Record<string, unknown>) ?? {},
    issueAutofixMode: (data?.issue_autofix_mode as 'off' | 'notify' | 'autonomous') ?? 'off',
    autoTriageEnabled: data?.auto_triage_enabled ?? true,
    autofixEnabled: data?.autofix_enabled ?? false,
    separateCommentPerStep: data?.separate_comment_per_step ?? false,
    actionAutoComment: data?.action_auto_comment ?? true,
  };
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
      <div className="mx-auto max-w-[1080px] px-8 py-6">
        <header className="mb-6">
          <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
            Settings
          </h1>
        </header>
        <div className="rounded-lg border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </div>
    );
  }

  const [{ config, issueAutofixMode, autoTriageEnabled, autofixEnabled, separateCommentPerStep, actionAutoComment }, members] = await Promise.all([
    loadWorkspaceConfig(workspace.id),
    loadMembers(workspace.id),
  ]);
  const isAdmin = workspace.role === 'admin';

  return (
    <SettingsTabs
      workspace={{
        name: workspace.name,
        repoOwner: workspace.repoOwner,
        repoName: workspace.repoName,
        role: workspace.role,
      }}
      automation={
        <SettingsCard
          title="Automation"
          description="How aggressively Cezar acts on incoming GitHub events. Defaults are safe; turning autofix on lets Cezar open draft PRs without a human in the loop."
        >
          <AutomationSection
            autoTriageEnabled={autoTriageEnabled}
            autofixEnabled={autofixEnabled}
            separateCommentPerStep={separateCommentPerStep}
            actionAutoComment={actionAutoComment}
            readOnly={!isAdmin}
          />
        </SettingsCard>
      }
      team={
        <SettingsCard
          title="Team"
          description="Workspace members and their roles. Only admins can invite, remove, or change roles."
        >
          <TeamSection members={members} isAdmin={isAdmin} currentUserId={user.id} />
        </SettingsCard>
      }
      configuration={
        <SettingsCard
          title="Configuration"
          description="Low-level autofix knobs — sync cadence, model selection, attempt budgets. Most workspaces leave the defaults alone."
        >
          <SettingsForm config={config} issueAutofixMode={issueAutofixMode} readOnly={!isAdmin} />
        </SettingsCard>
      }
    />
  );
}
