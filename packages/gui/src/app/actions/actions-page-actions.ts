'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface SeedDefaultsResult {
  ok: boolean;
  error?: string;
}

/**
 * Calls the `seed_default_actions(workspace_id)` RPC to refresh the built-in
 * action catalog: restores any that were deleted and inserts any newly
 * shipped ones. Idempotent — the RPC is `ON CONFLICT DO NOTHING` per
 * `(workspace_id, name, kind)`.
 */
export async function seedDefaultsForCurrentWorkspace(): Promise<SeedDefaultsResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can sync defaults' };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.rpc('seed_default_actions', { p_workspace_id: workspace.id });
  if (error) return { ok: false, error: error.message };
  revalidatePath('/actions');
  return { ok: true };
}
