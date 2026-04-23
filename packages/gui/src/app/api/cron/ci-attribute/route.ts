import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import { EventBridge } from '@/lib/adapters/event-bridge';
import type {
  CiAttribution,
  CiAttributionVerdict,
  CiFailedCheck,
} from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Attribution is slower and more expensive than a CI check — process
// fewer flows per tick to keep the cron well under the Vercel function
// timeout. One flow typically costs 1 LLM call plus ~3 GitHub reads.
const MAX_FLOWS_PER_TICK = 3;

// Per-job log cap. Enough to catch the actual error line (usually near the
// bottom of the log) without blowing the token budget.
const LOG_TAIL_LINES = 80;

// Never attribute PRs older than this — avoids hammering GitHub on flows
// that were abandoned. The ci-watch cron already has a 24h window; this
// mirror keeps the two in sync.
const WATCH_WINDOW_HOURS = 24;

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

  // Claim a batch of flows: set in_progress=true atomically so concurrent
  // cron invocations don't double-process the same flow.
  const { data: candidates, error } = await supabase
    .from('flows')
    .select('id')
    .eq('ci_status', 'failure')
    .is('ci_attribution', null)
    .eq('ci_attribution_in_progress', false)
    .gte('updated_at', since)
    .limit(MAX_FLOWS_PER_TICK);

  if (error) {
    console.error('[ci-attribute] candidate query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ attributed: 0 });
  }

  const ids = candidates.map(c => c.id);
  const { data: claimed } = await supabase
    .from('flows')
    .update({ ci_attribution_in_progress: true } as any)
    .in('id', ids)
    .eq('ci_attribution_in_progress', false)
    .is('ci_attribution', null)
    .select('*');

  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ attributed: 0, note: 'another worker claimed the batch' });
  }

  const results = await Promise.all(
    claimed.map(async (flow) => {
      try {
        return await attributeOne(flow as any, supabase);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ci-attribute] flow ${flow.id} failed:`, msg);
        // Release the lock so a future tick can retry.
        await supabase
          .from('flows')
          .update({ ci_attribution_in_progress: false } as any)
          .eq('id', flow.id);
        return { flowId: flow.id, ok: false, error: msg };
      }
    }),
  );

  return NextResponse.json({ attributed: claimed.length, results });
}

type ClaimedFlow = {
  id: string;
  workspace_id: string;
  actor_id: string;
  head_sha: string | null;
  pr_number: number | null;
  ci_failed_checks: unknown;
  ci_flaky_reruns: number;
};

async function attributeOne(
  flow: ClaimedFlow,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<{ flowId: string; ok: true; verdict: CiAttributionVerdict }> {
  if (!flow.head_sha) throw new Error('flow has no head_sha');
  if (!flow.pr_number) throw new Error('flow has no pr_number');

  const [{ data: tokenRow }] = await Promise.all([
    supabase.from('user_github_tokens').select('provider_token').eq('user_id', flow.actor_id).single(),
  ]);
  const token = tokenRow?.provider_token || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no github token available for actor');

  const config = await loadWorkspaceConfig(flow.workspace_id, supabase, { githubToken: token });
  if (!config.github.owner || !config.github.repo) throw new Error('workspace has no owner/repo');

  const core = await import('@cezar/core');
  const github = new core.GitHubService(config);

  // Load the inputs the attributor needs. Most are cheap parallel API calls.
  const failedChecks = ((flow.ci_failed_checks as CiFailedCheck[] | null) ?? []).map(c => ({
    name: c.name,
    status: 'completed' as const,
    conclusion: c.conclusion,
    htmlUrl: c.htmlUrl,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
  }));

  let baseChecks: Awaited<ReturnType<typeof github.listCheckRunsForSha>> = [];
  try {
    const baseSha = await github.getBaseBranchSha(config.autofix.baseBranch);
    baseChecks = await github.listCheckRunsForSha(baseSha);
  } catch (err) {
    // Base branch lookup failures are non-fatal — attribution can still
    // fall back to LLM-only without the deterministic control check.
    console.warn(`[ci-attribute] base-branch lookup failed for flow ${flow.id}:`, err);
  }

  const [prDiff, changedFiles] = await Promise.all([
    github.getPullRequestDiff(flow.pr_number).catch(() => ''),
    github.listPullRequestFiles(flow.pr_number).catch(() => []),
  ]);

  // Fetch log tails only for non-pre-existing failed checks — skip work for
  // checks we already know are unrelated. This is a chicken-and-egg with
  // base-branch control (we don't know which are pre-existing until we run
  // it), so do control once up front.
  const baseControl = core.runBaseBranchControl(failedChecks, baseChecks);
  const logTails = await fetchLogTails(github, baseControl.nonPreExistingChecks);

  // Only call the LLM if the user has an Anthropic key configured.
  let llm: InstanceType<typeof core.LLMService> | null = null;
  try {
    llm = new core.LLMService(config);
  } catch {
    llm = null;
  }

  const result = await core.runCiAttribution(
    {
      failedChecks,
      baseChecks,
      changedFiles,
      prDiff,
      logTails,
      flakyRerunsSoFar: flow.ci_flaky_reruns,
    },
    llm,
    config.llm.model,
  );

  // Persist attribution + lifecycle message.
  const writeResult = await supabase
    .from('flows')
    .update({
      ci_attribution: result as any,
      ci_attribution_checked_at: new Date().toISOString(),
      ci_attribution_in_progress: false,
    } as any)
    .eq('id', flow.id);

  if (writeResult.error) throw new Error(`write attribution failed: ${writeResult.error.message}`);

  await broadcastAttribution(supabase, flow.id, result);

  // Handle flaky re-run: one shot only.
  if (result.verdict === 'flaky' && flow.ci_flaky_reruns === 0) {
    await triggerFlakyRerun(github, supabase, flow, baseControl.nonPreExistingChecks);
  }

  return { flowId: flow.id, ok: true, verdict: result.verdict };
}

async function fetchLogTails(
  github: InstanceType<Awaited<typeof import('@cezar/core')>['GitHubService']>,
  checks: Array<{ name: string; htmlUrl: string | null }>,
): Promise<Array<{ checkName: string; lines: string[] }>> {
  const { parseCheckRunUrl } = await import('@cezar/core');
  const results: Array<{ checkName: string; lines: string[] }> = [];
  for (const check of checks) {
    const parsed = parseCheckRunUrl(check.htmlUrl);
    if (!parsed) continue;
    try {
      const log = await github.downloadJobLogs(parsed.jobId);
      const lines = log.split('\n').slice(-LOG_TAIL_LINES);
      results.push({ checkName: check.name, lines });
    } catch (err) {
      console.warn(`[ci-attribute] log fetch failed for ${check.name}:`, err);
    }
  }
  return results;
}

async function triggerFlakyRerun(
  github: InstanceType<Awaited<typeof import('@cezar/core')>['GitHubService']>,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  flow: ClaimedFlow,
  nonPreExistingChecks: Array<{ name: string; htmlUrl: string | null }>,
): Promise<void> {
  const { parseCheckRunUrl } = await import('@cezar/core');
  // Any workflow_run referenced by a failed check works — they all share
  // the same run when produced by one workflow. Pick the first we can parse.
  const parsed = nonPreExistingChecks.map(c => parseCheckRunUrl(c.htmlUrl)).find(p => p != null);
  if (!parsed) {
    console.warn(`[ci-attribute] flaky verdict but no parseable run URL for flow ${flow.id}`);
    return;
  }

  try {
    await github.reRunFailedJobs(parsed.runId);
  } catch (err) {
    console.warn(`[ci-attribute] rerun failed for flow ${flow.id}:`, err);
    return;
  }

  // Reset CI state so ci-watch picks the flow up again. Clear the prior
  // attribution so re-attribution can reach a different verdict if the
  // rerun still fails (the prompt uses flakyRerunsSoFar to forbid 'flaky'
  // on subsequent passes).
  await supabase
    .from('flows')
    .update({
      ci_status: 'pending',
      ci_failed_checks: [] as any,
      ci_attribution: null as any,
      ci_flaky_reruns: (flow.ci_flaky_reruns ?? 0) + 1,
    } as any)
    .eq('id', flow.id);

  const bridge = new EventBridge(flow.id, supabase);
  try {
    bridge.lifecycle(`CI — rerunning failed jobs (attribution: flaky; run #${parsed.runId})`);
  } finally {
    setTimeout(() => { bridge.dispose().catch(() => {}); }, 1500);
  }
}

async function broadcastAttribution(
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  flowId: string,
  result: CiAttribution,
): Promise<void> {
  const pct = Math.round(result.confidence * 100);
  const msg = `CI — attribution: ${result.verdict} (${pct}%, ${result.method})`;
  const bridge = new EventBridge(flowId, supabase);
  try {
    bridge.lifecycle(msg);
  } finally {
    setTimeout(() => { bridge.dispose().catch(() => {}); }, 1500);
  }
}
