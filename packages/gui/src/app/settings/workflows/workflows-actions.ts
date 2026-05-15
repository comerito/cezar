'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getActiveWorkspace } from '@/lib/workspace';
import { AUTOFIX_STEP_IDS, BUILTIN_TRIAGE_STEP_IDS } from '@cezar/core';
import type { WorkflowBackend } from '@/lib/supabase/types';

export interface SaveWorkflowState {
  ok?: boolean;
  error?: string;
}

const VALID_BACKENDS: WorkflowBackend[] = ['anthropic-api', 'claude-cli', 'codex-cli'];
const ALL_STEP_IDS: readonly string[] = [...AUTOFIX_STEP_IDS, ...BUILTIN_TRIAGE_STEP_IDS];

/**
 * Persists the per-step workflow bindings (repo-agnostic — `repo` is null).
 * For each step row: if everything is "default"/empty → delete any existing
 * binding; otherwise upsert it. Admin-only.
 */
export async function saveWorkflowBindings(
  _prev: SaveWorkflowState,
  formData: FormData,
): Promise<SaveWorkflowState> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { error: 'Only admins can update workflow bindings' };

  const supabase = await createSupabaseServerClient();

  for (const stepId of ALL_STEP_IDS) {
    const rawSkill = (formData.get(`skill.${stepId}`) as string | null)?.trim() ?? '';
    const rawBackend = (formData.get(`backend.${stepId}`) as string | null)?.trim() ?? '';
    // Model: either a <select> value, or 'custom' which reveals a text input.
    const selectModel = (formData.get(`model.${stepId}`) as string | null)?.trim() ?? '';
    const customModel = (formData.get(`modelCustom.${stepId}`) as string | null)?.trim() ?? '';
    const model = selectModel === 'custom' ? customModel : selectModel;
    const rawTools = (formData.get(`tools.${stepId}`) as string | null) ?? '';

    const skillName = rawSkill || null;
    const backend = (VALID_BACKENDS as string[]).includes(rawBackend)
      ? (rawBackend as WorkflowBackend)
      : null;
    const modelValue = model || null;
    const extraTools = rawTools
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const isDefault = !skillName && !backend && !modelValue && extraTools.length === 0;

    // The repo-agnostic uniqueness is enforced by a `coalesce(repo,'')` index,
    // which `ON CONFLICT (cols)` can't target — so delete-then-insert (repo is
    // null for every binding today) instead of upsert.
    const { error: delErr } = await supabase
      .from('workflow_bindings')
      .delete()
      .eq('workspace_id', workspace.id)
      .is('repo', null)
      .eq('step_id', stepId);
    if (delErr) return { error: delErr.message };

    if (isDefault) continue;

    const { error } = await supabase.from('workflow_bindings').insert({
      workspace_id: workspace.id,
      repo: null,
      step_id: stepId,
      skill_name: skillName,
      backend,
      model: modelValue,
      extra_tools: extraTools,
    });
    if (error) return { error: error.message };
  }

  revalidatePath('/settings/workflows');
  return { ok: true };
}
