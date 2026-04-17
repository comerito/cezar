'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import type { IssueStore, Config } from '@cezar/core';

export interface RunActionState {
  ok?: boolean;
  error?: string;
  actionId?: string;
}

export async function runAction(
  _prev: RunActionState,
  formData: FormData,
): Promise<RunActionState> {
  const actionId = formData.get('actionId') as string;
  if (!actionId) return { error: 'Missing actionId' };

  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };

  const runFn = ACTION_RUNNERS[actionId];
  if (!runFn) return { error: `Action "${actionId}" not yet wired in GUI`, actionId };

  try {
    const core = await import('@cezar/core');
    const supabase = createSupabaseAdminClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);
    const store = await core.IssueStore.fromPort(adapter);

    const githubToken = user.githubToken || process.env.GITHUB_TOKEN || '';

    let config: Config;
    try {
      config = await core.loadConfig();
    } catch {
      config = await core.loadConfig({ github: { owner: workspace.repoOwner, repo: workspace.repoName, token: '' } });
    }
    config.github.owner = workspace.repoOwner;
    config.github.repo = workspace.repoName;
    if (githubToken) config.github.token = githubToken;

    await runFn(store, config);
    await store.save();

    revalidatePath('/dashboard');
    revalidatePath('/issues');
    return { ok: true, actionId };
  } catch (err) {
    return { error: (err as Error).message, actionId };
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
