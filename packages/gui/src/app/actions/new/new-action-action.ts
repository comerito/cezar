'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { validateActionName } from './new-action-validation';

export interface CreateActionInput {
  name: string;
  description: string;
  target: 'issue' | 'pr';
}

export interface CreateActionResult {
  ok: boolean;
  error?: string;
  /** Path to navigate to on success (the new action's detail page). */
  redirectTo?: string;
}

/**
 * Creates an empty `user`-kind action. Returns a result envelope instead of
 * throwing so the client form can render validation/server errors inline
 * without triggering Next.js's unhandled-error overlay.
 */
export async function createUserAction(input: CreateActionInput): Promise<CreateActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can create actions' };

  const name = input.name.trim();
  const description = input.description.trim();
  const target: 'issue' | 'pr' = input.target === 'pr' ? 'pr' : 'issue';

  const nameError = validateActionName(name);
  if (nameError) return { ok: false, error: nameError };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('actions').insert({
    workspace_id: workspace.id,
    name,
    kind: 'user',
    description: description || null,
    system_prompt: '',
    skill_refs: [],
    target,
    triggers: ['manual'],
    effects: null,
    output_schema: null,
    enabled: true,
    created_by: user.id,
    updated_by: user.id,
  });

  if (error) {
    // Postgres unique violation — surface a friendlier message than the raw
    // constraint name.
    if ((error as { code?: string }).code === '23505' || /duplicate key/i.test(error.message)) {
      return { ok: false, error: `An action named "${name}" already exists in this workspace` };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath('/actions');
  revalidatePath(`/actions/${encodeURIComponent(name)}`);
  return { ok: true, redirectTo: `/actions/${encodeURIComponent(name)}` };
}
