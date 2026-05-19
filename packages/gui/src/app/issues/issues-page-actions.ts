'use server';

import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface IssueTargetAction {
  id: string;
  name: string;
  description: string | null;
  kind: 'built-in' | 'user';
}

/**
 * Enabled `target='issue'` actions for the current workspace, used by the
 * "Run action…" picker on the issues row kebab. User-kind rows shadow same-
 * named built-ins (mirrors the actions cockpit `preferred-row` rule).
 */
export async function listActionsForIssueTarget(): Promise<IssueTargetAction[]> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('actions')
    .select('id, name, kind, description, target, enabled')
    .eq('workspace_id', workspace.id)
    .eq('target', 'issue')
    .eq('enabled', true)
    .order('name', { ascending: true });

  if (!data) return [];

  const byName = new Map<string, IssueTargetAction>();
  for (const r of data) {
    const row: IssueTargetAction = {
      id: r.id,
      name: r.name,
      description: r.description,
      kind: r.kind as 'built-in' | 'user',
    };
    const existing = byName.get(r.name);
    if (!existing || (existing.kind === 'built-in' && row.kind === 'user')) {
      byName.set(r.name, row);
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}
