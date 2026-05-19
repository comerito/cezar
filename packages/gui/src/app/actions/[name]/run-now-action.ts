'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { createWorkflowRunPersister } from '@/lib/persist-workflow-run';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';

export interface RunNowResult {
  ok: boolean;
  error?: string;
  workflowRunId?: string;
}

/**
 * Real, synchronous "run this action against this issue" — the cockpit-bound
 * counterpart to the dry-run simulator. Persists a one-row `workflow_runs`
 * entry plus one `agent_runs` row and per-effect `agent_run_events` so the
 * cockpit page renders the same shape as a cron-dispatched triage pass.
 */
export async function runActionNow(actionId: string, issueNumber: number): Promise<RunNowResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };
  if (workspace.role !== 'admin') return { ok: false, error: 'Only admins can run actions' };

  const supabase = createSupabaseAdminClient();
  const core = await import('@cezar/core');

  // Load the action and the issue side-by-side.
  const { data: actionRow } = await supabase
    .from('actions')
    .select('id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled')
    .eq('id', actionId)
    .eq('workspace_id', workspace.id)
    .maybeSingle();
  if (!actionRow) return { ok: false, error: 'Action not found' };

  const { data: workspaceRow } = await supabase
    .from('workspaces')
    .select('action_auto_comment')
    .eq('id', workspace.id)
    .single();
  const autoCommentEnabled = workspaceRow?.action_auto_comment ?? true;

  const { data: issue } = await supabase
    .from('issues')
    .select('number, title, body, state, labels, html_url, comments')
    .eq('workspace_id', workspace.id)
    .eq('number', issueNumber)
    .maybeSingle();
  if (!issue) return { ok: false, error: `Issue #${issueNumber} not in the workspace's issue store` };

  // Resolve a GitHub token: prefer GitHub App install token, fall back to
  // the caller's OAuth token.
  let githubToken: string | null = null;
  if (core.GitHubAppService.isConfigured()) {
    try {
      githubToken = await new core.GitHubAppService().getInstallationToken(workspace.repoOwner);
    } catch (err) {
      console.warn('[run-now] GitHub App token failed, falling back to OAuth:', err instanceof Error ? err.message : err);
    }
  }
  if (!githubToken) githubToken = user.githubToken || process.env.GITHUB_TOKEN || null;
  if (!githubToken) return { ok: false, error: 'No GitHub token — sign out and back in to re-auth' };

  let config: Awaited<ReturnType<typeof loadWorkspaceConfig>>;
  try {
    config = await loadWorkspaceConfig(workspace.id, supabase, {
      githubToken,
      repoOwner: workspace.repoOwner,
      repoName: workspace.repoName,
    });
  } catch (err) {
    return { ok: false, error: `Failed to load workspace config: ${err instanceof Error ? err.message : String(err)}` };
  }

  const github = new core.GitHubService(config);
  const repoSlug = `${workspace.repoOwner}/${workspace.repoName}`;

  // ── persistence ─────────────────────────────────────────────────────────
  const persister = await createWorkflowRunPersister(supabase, {
    workspaceId: workspace.id,
    jobId: null,
    workflow: 'single-action',
    repo: repoSlug,
    issueNumber,
    onPersistError: (label, err) =>
      console.error(`[run-now] persist ${label} failed:`, err instanceof Error ? err.message : err),
  });
  if (!persister.id) return { ok: false, error: 'Could not create workflow_runs row' };

  await persister.recordEvent('lifecycle', {
    message: `run-now: ${actionRow.name} on #${issueNumber} (manual)`,
  });

  // Build an ActionTarget mirroring run-triage-pass-job.ts.
  const labels = Array.isArray(issue.labels) ? issue.labels.filter((l): l is string => typeof l === 'string') : [];
  const commentsArr = Array.isArray(issue.comments) ? issue.comments : [];
  type CommentLike = { author?: unknown; createdAt?: unknown; body?: unknown };
  const commentsText =
    commentsArr.length > 0
      ? commentsArr
          .map((c) => {
            const co = c as CommentLike;
            const author = typeof co.author === 'string' ? co.author : 'unknown';
            const createdAt = typeof co.createdAt === 'string' ? co.createdAt : '';
            const body = typeof co.body === 'string' ? co.body : '';
            return `- ${author} (${createdAt}): ${body.slice(0, 500)}`;
          })
          .join('\n')
      : undefined;

  const target: import('@cezar/core').ActionTarget = {
    kind: actionRow.target,
    number: issue.number,
    title: issue.title ?? '',
    body: issue.body ?? '',
    state: issue.state ?? 'open',
    labels,
    htmlUrl: issue.html_url ?? '',
    comments: commentsText,
  };

  const action: import('@cezar/core').ActionDef = {
    id: actionRow.id,
    workspaceId: workspace.id,
    name: actionRow.name,
    kind: actionRow.kind as 'built-in' | 'user',
    description: actionRow.description,
    systemPrompt: actionRow.system_prompt,
    skillRefs: Array.isArray(actionRow.skill_refs)
      ? (actionRow.skill_refs as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
    target: actionRow.target as 'issue' | 'pr',
    triggers: Array.isArray(actionRow.triggers)
      ? ((actionRow.triggers as unknown[]).filter((s): s is string => typeof s === 'string') as import('@cezar/core').ActionTrigger[])
      : [],
    effects:
      actionRow.effects == null
        ? null
        : Array.isArray(actionRow.effects)
          ? ((actionRow.effects as unknown[]).filter((s): s is string => typeof s === 'string') as import('@cezar/core').EffectName[])
          : null,
    outputSchema:
      actionRow.output_schema && typeof actionRow.output_schema === 'object' && !Array.isArray(actionRow.output_schema)
        ? (actionRow.output_schema as Record<string, unknown>)
        : null,
    enabled: actionRow.enabled,
  };

  const startedAt = new Date().toISOString();
  let runStatus: 'succeeded' | 'failed' = 'succeeded';
  let reason: string | undefined;
  let tokensUsed = 0;
  let summary: string | undefined;
  let runError: string | undefined;
  let effectsApplied: Array<{ call: import('@cezar/core').EffectCall; summary: string }> = [];

  try {
    const skills = await core.discoverBuiltinSkills();
    const result = await core.runAction(action, target, {
      skills,
      effectCtx: { github, targetNumber: issueNumber, supabase },
      autoComment: { enabled: autoCommentEnabled, triggeredBy: 'manual · run now' },
    });
    summary = result.text?.slice(0, 500);
    effectsApplied = result.effectsApplied;
    tokensUsed = result.usage.inputTokens + result.usage.outputTokens;
  } catch (err) {
    runStatus = 'failed';
    runError = err instanceof Error ? err.message : String(err);
    reason = runError;
  }

  const finishedAt = new Date().toISOString();
  const record: import('@cezar/core').AgentRunRecord = {
    id: randomUUID(),
    workflow: 'single-action',
    stepId: action.name,
    kind: 'agent',
    iteration: 0,
    backend: 'anthropic-api',
    model: 'claude-sonnet-4-6',
    status: runStatus,
    startedAt,
    finishedAt,
    tokensUsed,
    summary,
    error: runError,
  };
  await persister.recordAgentRun(record);

  for (const e of effectsApplied) {
    await persister.recordEvent('tool-call', {
      action: action.name,
      effect: e.call.effect,
      args: e.call.args,
      summary: e.summary,
    });
  }

  await persister.recordEvent('lifecycle', {
    message:
      runStatus === 'succeeded'
        ? `run-now: ${action.name} succeeded (${effectsApplied.length} effect${effectsApplied.length === 1 ? '' : 's'})`
        : `run-now: ${action.name} failed: ${runError ?? 'unknown error'}`,
  });

  await persister.finalize({
    status: runStatus,
    reason: reason ?? null,
    tokens_used: tokensUsed,
    finished_at: finishedAt,
    outcome: {
      action: action.name,
      effectsApplied: effectsApplied.map((e) => ({ effect: e.call.effect, args: e.call.args as never, summary: e.summary })),
    } as never,
  });

  revalidatePath('/cockpit');
  return { ok: true, workflowRunId: persister.id };
}

export interface RunNowIssue {
  number: number;
  title: string;
}

/**
 * Top-20 most-recently-updated issues from the local cache, used to populate
 * the "Run now" modal's dropdown. PR-targeted actions get the same list —
 * the GUI doesn't cache PRs separately, so the modal falls back to a free
 * number input on the client side when `target === 'pr'`.
 */
export async function listRecentIssuesForRunNow(): Promise<RunNowIssue[]> {
  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('issues')
    .select('number, title')
    .eq('workspace_id', workspace.id)
    .order('updated_at', { ascending: false })
    .limit(20);
  return (data ?? []).map((r) => ({ number: r.number, title: r.title ?? '' }));
}
