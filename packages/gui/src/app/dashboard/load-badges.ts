import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { computeBadges, type ActionBadge } from '@/lib/badges';

export async function loadWorkspaceBadges(
  workspaceId: string,
): Promise<Record<string, ActionBadge> | undefined> {
  try {
    const core = await import('@cezar/core');
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);

    let config: typeof core extends { Config: infer C } ? C : unknown;
    try {
      config = await core.loadConfig();
    } catch {
      config = await core.loadConfig({ github: { owner: '', repo: '', token: '' } });
    }

    return computeBadges(store, config as any);
  } catch (err) {
    console.error('[load-badges] Failed:', (err as Error).message);
    return undefined;
  }
}
