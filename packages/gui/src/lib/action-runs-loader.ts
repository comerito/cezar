import { createSupabaseAdminClient } from '@/lib/supabase/server';

// ─────────────────────────────────────────────────────────────────────
// Recent agent-run summaries grouped by issue or PR number.
// Powers the multi-dot status column on /issues and /prs.
//
// Each "dot" on a row represents one row from `agent_runs` — i.e. one
// action that ran as part of some workflow against this issue/PR. The
// inbox + cockpit pages already use the same join.
// ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'skipped';

export interface ActionRunSummary {
  agentRunId: string;
  workflowRunId: string;
  /** 'triage' | 'autofix' | 'ci-followup' | … */
  workflow: string;
  /** Step id within the workflow — for the data-driven path this is the
   *  action name (e.g. 'duplicates', 'bug-detector'); for autofix it's
   *  'analyzer' / 'fixer' / 'reviewer' / 'commit' / 'open-pr'. */
  actionName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
  /** Number of pending_decisions rows produced by this run. */
  findingsCount: number;
}

const PER_ROW_CAP = 5;
const TOTAL_FETCH_CAP = 500;

interface JoinedAgentRunRow {
  id: string;
  step_id: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  workflow_run_id: string;
  workflow_runs: {
    workflow: string;
    issue_number: number | null;
    pr_number: number | null;
    status: 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
  } | null;
}

/**
 * For each issue (or PR) number in the workspace, return the most recent
 * action-level runs, capped at `PER_ROW_CAP` per row. Returned arrays are
 * newest-first.
 *
 * Sourcing strategy: pull the latest `TOTAL_FETCH_CAP` agent_runs in the
 * workspace via one join against workflow_runs, group in JS, take the
 * head N per group. Acceptable up to ~thousand-rows-per-day per
 * workspace; promote to a Postgres view if/when it stops being.
 */
export async function fetchRecentActionRuns(
  workspaceId: string,
  kind: 'issue' | 'pr',
): Promise<Map<number, ActionRunSummary[]>> {
  const supabase = createSupabaseAdminClient();
  const numberField: 'issue_number' | 'pr_number' = kind === 'issue' ? 'issue_number' : 'pr_number';

  // PostgREST inner-join. Embedded-table filters (`workflow_runs.issue_number`)
  // are flaky across PostgREST versions; we just fetch everything and skip
  // null-target rows in the loop below.
  const { data, error } = await supabase
    .from('agent_runs')
    .select(
      `id, step_id, status, started_at, finished_at, summary, error, workflow_run_id,
       workflow_runs!inner ( workflow, issue_number, pr_number, status )`,
    )
    .eq('workspace_id', workspaceId)
    .order('started_at', { ascending: false })
    .limit(TOTAL_FETCH_CAP)
    .returns<JoinedAgentRunRow[]>();
  // numberField is preserved in the function signature for symmetry but
  // applied client-side via the `kind` switch below.
  void numberField;

  if (error || !data) return new Map();

  // Findings counts — fetch the agent_run_id of every still-pending decision
  // in the workspace, then count locally. Cheaper than a per-row aggregate
  // round trip and the visible set is small.
  const agentRunIds = data.map((r) => r.id);
  const findingsCountByRunId = await fetchFindingsCounts(workspaceId, agentRunIds);

  const out = new Map<number, ActionRunSummary[]>();
  for (const row of data) {
    const parent = row.workflow_runs;
    if (!parent) continue;
    const num = kind === 'issue' ? parent.issue_number : parent.pr_number;
    if (num == null) continue;
    const list = out.get(num) ?? [];
    if (list.length >= PER_ROW_CAP) continue;
    list.push({
      agentRunId: row.id,
      workflowRunId: row.workflow_run_id,
      workflow: parent.workflow,
      actionName: row.step_id,
      // Bubble paused workflow-run status up to the action — an action that
      // 'succeeded' inside a workflow whose human-gate is still open shows as
      // running-ish in the UI, but we explicitly let the action's own status
      // win. (`paused` is a workflow-only state.)
      status: row.status as RunStatus,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      summary: row.summary,
      error: row.error,
      findingsCount: findingsCountByRunId.get(row.id) ?? 0,
    });
    out.set(num, list);
  }
  return out;
}

async function fetchFindingsCounts(
  workspaceId: string,
  agentRunIds: string[],
): Promise<Map<string, number>> {
  if (agentRunIds.length === 0) return new Map();
  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('pending_decisions')
    .select('agent_run_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .not('agent_run_id', 'is', null)
    .in('agent_run_id', agentRunIds);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    if (!row.agent_run_id) continue;
    counts.set(row.agent_run_id, (counts.get(row.agent_run_id) ?? 0) + 1);
  }
  return counts;
}
