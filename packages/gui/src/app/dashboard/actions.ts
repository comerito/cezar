'use server';

import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';

/**
 * Dashboard action dispatcher — the legacy per-action runners were removed in
 * commit 2b2 along with the `@cezar/core` action-plugin tree. The new
 * data-driven action model exposes the same surface through the `/actions`
 * cockpit (commit 2c); this stub keeps the dashboard tile buttons compiling
 * until then so we don't have to ship the new cockpit and the deletion in the
 * same change.
 */
export async function startAction(_actionId: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  return {
    ok: false,
    error: 'Dashboard action dispatch is being rebuilt — use the actions cockpit (coming in commit 2c).',
  };
}
