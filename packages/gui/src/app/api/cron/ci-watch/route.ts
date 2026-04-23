import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { EventBridge } from '@/lib/adapters/event-bridge';
import type { CiStatus, CiFailedCheck } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Only poll flows whose PR was opened in the last 24h. Anything older either
// already resolved or has gone stale — surface it as 'unknown' on the next
// manual refresh rather than hammering GitHub forever.
const WATCH_WINDOW_HOURS = 24;

// Cap per-tick work so one wedge-ful of flows can't blow the cron timeout.
const MAX_FLOWS_PER_TICK = 20;

export async function GET(req: Request) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET>.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();

  const since = new Date(Date.now() - WATCH_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: flows, error } = await supabase
    .from('flows')
    .select('id, workspace_id, actor_id, head_sha, ci_status, pr_number')
    .eq('status', 'pr-opened')
    .not('head_sha', 'is', null)
    .or('ci_status.is.null,ci_status.eq.pending')
    .gte('updated_at', since)
    .limit(MAX_FLOWS_PER_TICK);

  if (error) {
    console.error('[ci-watch] query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!flows || flows.length === 0) {
    return NextResponse.json({ checked: 0 });
  }

  const core = await import('@cezar/core');
  const results = await Promise.all(
    flows.map(async (flow) => {
      try {
        return await checkOne(flow, supabase, core);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ci-watch] flow ${flow.id} failed:`, msg);
        return { flowId: flow.id, ok: false, error: msg };
      }
    }),
  );

  return NextResponse.json({ checked: flows.length, results });
}

async function checkOne(
  flow: { id: string; workspace_id: string; actor_id: string; head_sha: string | null; ci_status: CiStatus | null; pr_number: number | null },
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  core: typeof import('@cezar/core'),
): Promise<{ flowId: string; ok: true; ci: CiStatus }> {
  if (!flow.head_sha) throw new Error('flow has no head_sha');

  const [{ data: workspace }, { data: tokenRow }] = await Promise.all([
    supabase.from('workspaces').select('repo_owner, repo_name').eq('id', flow.workspace_id).single(),
    supabase.from('user_github_tokens').select('provider_token').eq('user_id', flow.actor_id).single(),
  ]);

  if (!workspace) throw new Error('workspace not found');
  const token = tokenRow?.provider_token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no github token available for actor');

  // Minimal Config for GitHubService — we only need repo + token for read ops.
  const github = new core.GitHubService({
    github: { owner: workspace.repo_owner, repo: workspace.repo_name, token },
  } as any);

  const summary = await github.getCiStatus(flow.head_sha);

  const failedChecks: CiFailedCheck[] = summary.failedChecks.map(c => ({
    name: c.name,
    conclusion: c.conclusion,
    htmlUrl: c.htmlUrl,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  }));

  // Only write if something actually changed — avoids stream of duplicate
  // lifecycle events in the cockpit feed on every tick.
  const changed = flow.ci_status !== summary.overall;

  await supabase
    .from('flows')
    .update({
      ci_status: summary.overall,
      ci_checked_at: new Date().toISOString(),
      ci_failed_checks: failedChecks as any,
    } as any)
    .eq('id', flow.id);

  if (changed) {
    const bridge = new EventBridge(flow.id, supabase);
    try {
      const msg = ciLifecycleMessage(summary.overall, summary.total, failedChecks.length, flow.pr_number);
      bridge.lifecycle(msg);
    } finally {
      // Give broadcast a moment to flush before tearing the channel down.
      setTimeout(() => { bridge.dispose().catch(() => {}); }, 1500);
    }
  }

  return { flowId: flow.id, ok: true, ci: summary.overall };
}

function ciLifecycleMessage(overall: CiStatus, total: number, failed: number, prNumber: number | null): string {
  const prTag = prNumber ? `PR #${prNumber}` : 'PR';
  switch (overall) {
    case 'pending':  return `CI — ${prTag} pending (${total} check${total === 1 ? '' : 's'} running)`;
    case 'success':  return `CI — ${prTag} passed (${total} check${total === 1 ? '' : 's'})`;
    case 'failure':  return `CI — ${prTag} failed (${failed} of ${total} check${total === 1 ? '' : 's'})`;
    case 'neutral':  return `CI — ${prTag} neutral (${total} check${total === 1 ? '' : 's'})`;
    case 'unknown':  return `CI — ${prTag}: no checks found on head commit`;
  }
}
