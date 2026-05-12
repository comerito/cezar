import { NextResponse } from 'next/server';
import { authRunner, runnerScopesWorkspace } from '../../../_auth';
import type { Database, AgentRunEventType, AgentRunStatus, AgentRunStepKind } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type AgentRunsRow = Database['public']['Tables']['agent_runs']['Row'];

interface IncomingEvent {
  type: AgentRunEventType | string;
  payload?: unknown;
  agentRunId?: string;
  stepId?: string;
  iteration?: number;
  kind?: string;
  backend?: string | null;
  model?: string | null;
  status?: string;
  summary?: string | null;
  error?: string | null;
  tokensUsed?: number;
  startedAt?: string;
  finishedAt?: string | null;
}

/**
 * POST /api/runner/runs/:runId/events  { events: IncomingEvent[] }
 *
 * The runner batches events here. For step lifecycle events we upsert an
 * `agent_runs` row (insert on `step-start`, update on `step-end`) and advance
 * `workflow_runs.current_step_id`; every event is also recorded in
 * `agent_run_events`. `tokensUsed` accumulates into `workflow_runs.tokens_used`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const auth = await authRunner(req);
  if (auth instanceof NextResponse) return auth;
  const { runner, admin } = auth;
  const { runId } = await params;

  const { data: run } = await admin.from('workflow_runs').select('id, workspace_id').eq('id', runId).maybeSingle();
  if (!run) return NextResponse.json({ error: 'run not found' }, { status: 404 });
  if (!runnerScopesWorkspace(runner, run.workspace_id)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: { events?: IncomingEvent[] };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const events = Array.isArray(body.events) ? body.events : [];

  // Resolve a step's agent_runs row id within this batch (step-start creates it).
  const stepRunIds = new Map<string, string>(); // `${stepId}#${iteration}` -> agent_runs.id
  const stepKey = (e: IncomingEvent) => `${e.stepId}#${e.iteration ?? 1}`;
  let tokenDelta = 0;
  let lastStepId: string | null = null;

  for (const e of events) {
    if (typeof e.tokensUsed === 'number') tokenDelta += e.tokensUsed;

    let agentRunId: string | null = e.agentRunId ?? null;

    if (e.stepId && e.type === 'step-start') {
      const { data, error } = await admin
        .from('agent_runs')
        .insert({
          workspace_id: run.workspace_id,
          workflow_run_id: runId,
          step_id: e.stepId,
          iteration: e.iteration ?? 1,
          kind: (e.kind ?? null) as AgentRunStepKind | null,
          backend: e.backend ?? null,
          model: e.model ?? null,
          status: 'running',
          started_at: e.startedAt ?? new Date().toISOString(),
        })
        .select('id')
        .single();
      if (!error && data) { stepRunIds.set(stepKey(e), data.id); agentRunId = data.id; }
      lastStepId = e.stepId;
      await admin.from('workflow_runs').update({ current_step_id: e.stepId }).eq('id', runId);
    } else if (e.stepId && e.type === 'step-end') {
      const existing = stepRunIds.get(stepKey(e));
      const dbStatus: AgentRunStatus =
        e.status === 'succeeded' ? 'succeeded' : e.status === 'skipped' ? 'skipped' : e.status === 'running' ? 'running' : 'failed';
      if (existing) {
        await admin.from('agent_runs').update({
          status: dbStatus, finished_at: e.finishedAt ?? new Date().toISOString(),
          tokens_used: e.tokensUsed ?? 0, summary: e.summary ?? null, error: e.error ?? null,
          kind: (e.kind ?? undefined) as AgentRunsRow['kind'] | undefined,
        }).eq('id', existing);
        agentRunId = existing;
      } else {
        // No matching step-start in this/an earlier batch — insert a closed row.
        const { data } = await admin.from('agent_runs').insert({
          workspace_id: run.workspace_id, workflow_run_id: runId, step_id: e.stepId, iteration: e.iteration ?? 1,
          kind: (e.kind ?? null) as AgentRunStepKind | null, backend: e.backend ?? null, model: e.model ?? null,
          status: dbStatus, started_at: e.startedAt ?? new Date().toISOString(), finished_at: e.finishedAt ?? new Date().toISOString(),
          tokens_used: e.tokensUsed ?? 0, summary: e.summary ?? null, error: e.error ?? null,
        }).select('id').single();
        agentRunId = data?.id ?? null;
      }
      lastStepId = e.stepId;
    }

    await admin.from('agent_run_events').insert({
      workspace_id: run.workspace_id,
      workflow_run_id: runId,
      agent_run_id: agentRunId,
      type: (isKnownEventType(e.type) ? e.type : 'note') as AgentRunEventType,
      payload: (e.payload ?? {}) as Database['public']['Tables']['agent_run_events']['Row']['payload'],
    });
  }

  if (tokenDelta > 0) {
    const { data: cur } = await admin.from('workflow_runs').select('tokens_used').eq('id', runId).single();
    await admin.from('workflow_runs').update({ tokens_used: (cur?.tokens_used ?? 0) + tokenDelta }).eq('id', runId);
  }
  if (lastStepId) {
    // (current_step_id already set on step-start; this keeps it fresh for batches
    // that only carried step-end events.)
    await admin.from('workflow_runs').update({ current_step_id: lastStepId }).eq('id', runId);
  }

  return NextResponse.json({ ok: true });
}

function isKnownEventType(t: string): t is AgentRunEventType {
  return ['lifecycle', 'agent-text', 'tool-call', 'tool-result', 'note', 'step-start', 'step-end'].includes(t);
}
