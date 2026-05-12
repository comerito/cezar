'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';

export interface SaveAutomationState {
  ok?: boolean;
  error?: string;
}

/**
 * Phase 5 — the three automation toggles on `workspaces`:
 *   - `auto_triage_enabled` — run the triage workflow on new/edited issues.
 *   - `autofix_enabled` — when a triage run routes to `autofix` (and the bug
 *     confidence clears the threshold), open a draft PR automatically.
 *   - `separate_comment_per_step` — render each workflow step as its own comment
 *     instead of one living comment.
 * Admin-only.
 */
export async function saveAutomationToggles(
  _prev: SaveAutomationState,
  formData: FormData,
): Promise<SaveAutomationState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can change automation settings' };

  const bool = (key: string): boolean => formData.get(key) === 'on' || formData.get(key) === 'true';

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('workspaces')
    .update({
      auto_triage_enabled: bool('autoTriageEnabled'),
      autofix_enabled: bool('autofixEnabled'),
      separate_comment_per_step: bool('separateCommentPerStep'),
    })
    .eq('id', workspace.id);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
