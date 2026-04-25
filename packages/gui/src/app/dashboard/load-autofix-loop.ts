import { createSupabaseAdminClient } from '@/lib/supabase/server';
import type { IssueAutofixMode } from '@/lib/supabase/types';

export interface AutofixLoopStats {
  mode: IssueAutofixMode;
  notified: number;
  dispatched: number;
  matchedToPr: number;
}

/**
 * Counts candidates by status for the dashboard card. Uses the admin client
 * because the dashboard page must succeed even if RLS would otherwise hide
 * rows (it's running on behalf of an authenticated workspace member already).
 */
export async function loadAutofixLoopStats(workspaceId: string): Promise<AutofixLoopStats | null> {
  try {
    const supabase = createSupabaseAdminClient();

    const { data: ws } = await supabase
      .from('workspaces')
      .select('issue_autofix_mode')
      .eq('id', workspaceId)
      .single();

    const mode: IssueAutofixMode = (ws?.issue_autofix_mode as IssueAutofixMode) ?? 'off';

    const [{ count: notified }, { count: dispatched }, { count: matchedToPr }] = await Promise.all([
      supabase
        .from('issue_autofix_candidates')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'notified'),
      supabase
        .from('issue_autofix_candidates')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'dispatched'),
      supabase
        .from('issue_autofix_candidates')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('status', 'matched_to_pr'),
    ]);

    return {
      mode,
      notified: notified ?? 0,
      dispatched: dispatched ?? 0,
      matchedToPr: matchedToPr ?? 0,
    };
  } catch {
    return null;
  }
}
