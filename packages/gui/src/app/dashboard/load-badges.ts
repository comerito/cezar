import { IssueStore, loadConfig } from '@cezar/core';
import type { Config } from '@cezar/core';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { computeBadges, type ActionBadge } from '@/lib/badges';

export async function loadWorkspaceBadges(
  workspaceId: string,
): Promise<Record<string, ActionBadge> | undefined> {
  try {
    const supabase = await createSupabaseServerClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);
    const store = await IssueStore.fromPort(adapter);

    let config: Config;
    try {
      config = await loadConfig();
    } catch {
      config = await loadConfig({ github: { owner: '', repo: '', token: '' } });
    }

    return computeBadges(store, config);
  } catch {
    return undefined;
  }
}
