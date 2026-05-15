'use server';

import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { getSessionUser } from '@/lib/auth';
import { setActiveWorkspace } from '@/lib/workspace';
import { redirect } from 'next/navigation';

export interface CreateWorkspaceState {
  error?: string;
}

export async function createWorkspace(
  _prev: CreateWorkspaceState,
  formData: FormData,
): Promise<CreateWorkspaceState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };

  const name = (formData.get('name') as string)?.trim();
  const repoOwner = (formData.get('repo_owner') as string)?.trim();
  const repoName = (formData.get('repo_name') as string)?.trim();

  if (!name || !repoOwner || !repoName) {
    return { error: 'All fields are required' };
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return { error: 'Name must contain at least one alphanumeric character' };

  // Workspace creation uses the service-role client because the user isn't a
  // member yet — RLS would block both the workspace INSERT and the initial
  // membership INSERT. Auth is already verified above via getSessionUser().
  const supabase = createSupabaseAdminClient();

  const { data: workspace, error: wsErr } = await supabase
    .from('workspaces')
    .insert({ slug, name, repo_owner: repoOwner, repo_name: repoName })
    .select('id')
    .single();

  if (wsErr) {
    if (wsErr.code === '23505') {
      return { error: 'A workspace with this repo or slug already exists' };
    }
    return { error: wsErr.message };
  }

  const { error: memErr } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: workspace.id, user_id: user.id, role: 'admin' });

  if (memErr) {
    return { error: `Workspace created but failed to add you as admin: ${memErr.message}` };
  }

  await setActiveWorkspace(workspace.id);
  redirect('/dashboard');
}

export async function deleteWorkspace(workspaceId: string) {
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('workspaces').delete().eq('id', workspaceId);
  if (error) throw new Error(error.message);
  redirect('/dashboard');
}
