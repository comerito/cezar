import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { computeBadges, type ActionBadge } from '@/lib/badges';

export async function loadWorkspaceBadges(
  workspaceId: string,
): Promise<Record<string, ActionBadge> | undefined> {
  try {
    const core = await import('@cezar/core');
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);
    const config = await loadWorkspaceConfig(workspaceId, supabase);

    return computeBadges(store, config);
  } catch (err) {
    console.error('[load-badges] Failed:', (err as Error).message);
    return undefined;
  }
}
