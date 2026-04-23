import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { ensureRepoClone } from '@/lib/repo-clone';
import { EventBridge } from '@/lib/adapters/event-bridge';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import type { CiAttribution, CiFailedCheck } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// One fix attempt per tick. processCiFollowup runs agent sessions that can
// take many minutes; kicking off more than one per cron invocation risks
// thrashing the serverless instance.
const MAX_FLOWS_PER_TICK = 1;

const WATCH_WINDOW_HOURS = 24;

const LOG_TAIL_LINES = 60;

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();
  const since = new Date(Date.now() - WATCH_WINDOW_HOURS * 3600 * 1000).toISOString();

  // Eligibility: attribution says 'ours', not already fixing, updated recently.
  // ci_fix_attempts cap is applied per-flow after loading its workspace config,
  // since the max is configurable.
  const { data: candidates, error } = await supabase
    .from('flows')
    .select('id')
    .eq('ci_fix_in_progress', false)
    .filter('ci_attribution->>verdict', 'eq', 'ours')
    .gte('updated_at', since)
    .limit(MAX_FLOWS_PER_TICK);

  if (error) {
    console.error('[ci-fix] candidate query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ fixed: 0 });
  }

  const ids = candidates.map(c => c.id);
  const { data: claimed } = await supabase
    .from('flows')
    .update({ ci_fix_in_progress: true } as any)
    .in('id', ids)
    .eq('ci_fix_in_progress', false)
    .filter('ci_attribution->>verdict', 'eq', 'ours')
    .select('*');

  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ fixed: 0, note: 'another worker claimed the batch' });
  }

  // Fire-and-forget — the follow-up orchestrator does agent work that
  // outlives this response. Mirrors the pattern in app/flows/actions.ts.
  for (const flow of claimed) {
    runFollowup(flow as any, supabase).catch((err) => {
      console.error(`[ci-fix] flow ${flow.id} crashed:`, err);
    });
  }

  return NextResponse.json({ fixed: claimed.length, dispatched: claimed.map(c => c.id) });
}

type ClaimedFlow = {
  id: string;
  workspace_id: string;
  actor_id: string;
  issue_number: number;
  branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  ci_attribution: CiAttribution | null;
  ci_failed_checks: CiFailedCheck[] | null;
  ci_fix_attempts: number;
};

async function runFollowup(
  flow: ClaimedFlow,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<void> {
  const bridge = new EventBridge(flow.id, supabase);
  const releaseLock = async (patch: Record<string, unknown> = {}): Promise<void> => {
    await supabase
      .from('flows')
      .update({ ci_fix_in_progress: false, ...patch } as any)
      .eq('id', flow.id);
  };

  try {
    if (!flow.branch || !flow.pr_number || !flow.ci_attribution) {
      await releaseLock();
      return;
    }

    const [{ data: tokenRow }] = await Promise.all([
      supabase.from('user_github_tokens').select('provider_token').eq('user_id', flow.actor_id).single(),
    ]);
    const token = tokenRow?.provider_token || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('no github token available for actor');

    const config = await loadWorkspaceConfig(flow.workspace_id, supabase, { githubToken: token });
    if (!config.github.owner || !config.github.repo) throw new Error('workspace has no owner/repo');

    // Per-workspace cap on follow-ups. Cron scheduled us before loading the
    // config, so this is where we actually honour the ceiling.
    if (flow.ci_fix_attempts >= (config.autofix.ciFixMax ?? 2)) {
      bridge.lifecycle(`CI-FIX — cap reached (${flow.ci_fix_attempts}/${config.autofix.ciFixMax}); not spawning another follow-up`);
      await releaseLock();
      return;
    }

    // The cron environment may not have a repo on disk yet; clone on demand.
    if (!config.autofix.repoRoot) {
      bridge.lifecycle('CI-FIX — cloning repository');
      const repoRoot = await ensureRepoClone(
        config.github.owner,
        config.github.repo,
        config.github.token,
        config.autofix.baseBranch,
      );
      config.autofix.repoRoot = repoRoot;
    }

    const core = await import('@cezar/core');
    const storeAdapter = new SupabaseStoreAdapter(supabase, flow.workspace_id);
    const store = await core.IssueStore.fromPort(storeAdapter);
    const github = new core.GitHubService(config);
    const orchestrator = new core.AutofixOrchestrator(store, config, github);

    // Log tails aren't persisted on the flow — re-fetch them from GitHub so
    // the fixer has the same evidence the attributor saw. Best-effort.
    const failedChecks = flow.ci_failed_checks ?? [];
    const logTails = await fetchLogTails(github, failedChecks, core.parseCheckRunUrl);

    const attemptIndex = flow.ci_fix_attempts + 1;
    const attemptMax = config.autofix.ciFixMax ?? 2;

    const outcome = await orchestrator.processCiFollowup(
      {
        issueNumber: flow.issue_number,
        prNumber: flow.pr_number,
        branch: flow.branch,
        attemptIndex,
        attemptMax,
        attribution: {
          reasoning: flow.ci_attribution.reasoning,
          suggestedFocus: flow.ci_attribution.suggestedFocus,
          preExistingChecks: flow.ci_attribution.preExistingChecks,
        },
        failedCheckNames: failedChecks.map(c => c.name),
        logTails,
      },
      {
        apply: true,
        onEvent: (msg) => bridge.lifecycle(msg),
        onAgentEvent: (evt) => bridge.agent(evt),
      },
    );

    if (outcome.status === 'pushed') {
      // Reset CI state so ci-watch picks up the new commit next tick.
      // Clearing ci_attribution lets ci-attribute re-evaluate if the new
      // commit still fails — the prompt sees the bumped ci_fix_attempts and
      // is less likely to call it flaky.
      await supabase
        .from('flows')
        .update({
          head_sha: outcome.headSha,
          ci_status: 'pending',
          ci_failed_checks: [] as any,
          ci_attribution: null,
          ci_attribution_checked_at: null,
          ci_fix_attempts: attemptIndex,
          ci_fix_in_progress: false,
        } as any)
        .eq('id', flow.id);
      bridge.lifecycle(`CI-FIX — pushed ${outcome.headSha.slice(0, 8)} to ${outcome.branch} (attempt ${attemptIndex}/${attemptMax})`);
      return;
    }

    // Non-pushed outcomes: count the attempt but leave attribution intact
    // so the user can see why it stopped.
    await releaseLock({ ci_fix_attempts: attemptIndex });
    bridge.lifecycle(
      outcome.status === 'skipped'
        ? `CI-FIX — skipped: ${outcome.reason}`
        : `CI-FIX — failed: ${outcome.reason}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ci-fix] flow ${flow.id} error:`, msg);
    await releaseLock();
    bridge.lifecycle(`CI-FIX FATAL — ${msg}`);
  } finally {
    setTimeout(() => bridge.dispose().catch(() => {}), 3000);
  }
}

async function fetchLogTails(
  github: InstanceType<Awaited<typeof import('@cezar/core')>['GitHubService']>,
  checks: CiFailedCheck[],
  parseCheckRunUrl: typeof import('@cezar/core')['parseCheckRunUrl'],
): Promise<Array<{ checkName: string; lines: string[] }>> {
  const results: Array<{ checkName: string; lines: string[] }> = [];
  for (const check of checks) {
    const parsed = parseCheckRunUrl(check.htmlUrl);
    if (!parsed) continue;
    try {
      const log = await github.downloadJobLogs(parsed.jobId);
      results.push({ checkName: check.name, lines: log.split('\n').slice(-LOG_TAIL_LINES) });
    } catch {
      // Best-effort — attribution worked without logs too.
    }
  }
  return results;
}
