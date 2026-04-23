'use server';

import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';
import type { IssueStore, Config } from '@cezar/core';

export async function startAction(actionId: string): Promise<{ ok: boolean; runId?: string; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };

  const runId = `action-${actionId}-${Date.now()}`;

  runActionInBackground(runId, actionId, workspace.id, workspace.repoOwner, workspace.repoName, user.githubToken).catch((err) => {
    console.error(`[action ${runId}] crashed:`, err);
  });

  return { ok: true, runId };
}

async function runActionInBackground(
  runId: string,
  actionId: string,
  workspaceId: string,
  repoOwner: string,
  repoName: string,
  githubToken: string | null,
) {
  const supabase = createSupabaseAdminClient();
  const channel = supabase.channel(runId);
  await channel.subscribe();

  function emit(stage: string, message: string, current?: number, total?: number) {
    channel.send({ type: 'broadcast', event: 'progress', payload: { stage, message, current, total, actionId } });
  }

  try {
    emit('init', `Starting ${actionId}...`);
    const core = await import('@cezar/core');
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);
    const store = await core.IssueStore.fromPort(adapter);

    const config = await loadWorkspaceConfig(workspaceId, supabase, {
      githubToken: githubToken || undefined,
      repoOwner,
      repoName,
    });

    const runFn = ACTION_RUNNERS[actionId];
    if (!runFn) {
      emit('error', `Action "${actionId}" not wired in GUI`);
      return;
    }

    emit('running', `Running ${actionId}...`);
    await runFn(store, config);
    await store.save();

    emit('done', `${actionId} completed`);
  } catch (err) {
    emit('error', (err as Error).message);
  } finally {
    setTimeout(() => supabase.removeChannel(channel), 5000);
  }
}

type RunFn = (store: IssueStore, config: Config) => Promise<void>;

const ACTION_RUNNERS: Record<string, RunFn> = {
  duplicates: async (store, config) => {
    const { DuplicatesRunner } = await import('@cezar/core');
    await new DuplicatesRunner(store, config).detect({ state: 'open', recheck: false, dryRun: false, format: 'json' });
  },
  priority: async (store, config) => {
    const { PriorityRunner } = await import('@cezar/core');
    await new PriorityRunner(store, config).analyze();
  },
  'auto-label': async (store, config) => {
    const { AutoLabelRunner } = await import('@cezar/core');
    await new AutoLabelRunner(store, config).analyze();
  },
  'bug-detector': async (store, config) => {
    const { BugDetectorRunner } = await import('@cezar/core');
    await new BugDetectorRunner(store, config).analyze();
  },
  categorize: async (store, config) => {
    const { CategorizeRunner } = await import('@cezar/core');
    await new CategorizeRunner(store, config).analyze();
  },
  quality: async (store, config) => {
    const { QualityRunner } = await import('@cezar/core');
    await new QualityRunner(store, config).check();
  },
  'missing-info': async (store, config) => {
    const { MissingInfoRunner } = await import('@cezar/core');
    await new MissingInfoRunner(store, config).detect();
  },
  stale: async (store, config) => {
    const { StaleRunner } = await import('@cezar/core');
    await new StaleRunner(store, config).analyze();
  },
  'done-detector': async (store, config) => {
    const { DoneDetectorRunner } = await import('@cezar/core');
    await new DoneDetectorRunner(store, config).detect();
  },
  'good-first-issue': async (store, config) => {
    const { GoodFirstIssueRunner } = await import('@cezar/core');
    await new GoodFirstIssueRunner(store, config).analyze();
  },
  security: async (store, config) => {
    const { SecurityRunner } = await import('@cezar/core');
    await new SecurityRunner(store, config).scan();
  },
  'needs-response': async (store, config) => {
    const { NeedsResponseRunner } = await import('@cezar/core');
    await new NeedsResponseRunner(store, config).analyze();
  },
  'claim-detector': async (store, config) => {
    const { ClaimDetectorRunner } = await import('@cezar/core');
    await new ClaimDetectorRunner(store, config).detect();
  },
  'recurring-questions': async (store, config) => {
    const { RecurringQuestionRunner } = await import('@cezar/core');
    await new RecurringQuestionRunner(store, config).detect();
  },
  'milestone-planner': async (store, config) => {
    const { MilestonePlanRunner } = await import('@cezar/core');
    await new MilestonePlanRunner(store, config).plan();
  },
};
