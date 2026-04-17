'use server';

import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';

export interface SyncState {
  ok?: boolean;
  error?: string;
  fetched?: number;
  digested?: number;
}

export async function syncAndDigest(_prev: SyncState): Promise<SyncState> {
  const user = await getSessionUser();
  if (!user) return { error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { error: 'No workspace selected' };

  try {
    const core = await import('@cezar/core');
    const supabase = createSupabaseAdminClient();
    const adapter = new SupabaseStoreAdapter(supabase, workspace.id);

    let store: Awaited<ReturnType<typeof core.IssueStore.fromPort>>;
    try {
      store = await core.IssueStore.fromPort(adapter);
    } catch {
      const emptyAdapter = new SupabaseStoreAdapter(supabase, workspace.id);
      store = await core.IssueStore.fromPort({
        async load() {
          return {
            meta: {
              owner: workspace.repoOwner,
              repo: workspace.repoName,
              lastSyncedAt: null,
              totalFetched: 0,
              version: 1 as const,
              orgMembers: [],
              orgMembersFetchedAt: null,
            },
            issues: [],
          };
        },
        async save(data) { await emptyAdapter.save(data); },
      });
    }

    let config: Awaited<ReturnType<typeof core.loadConfig>>;
    try {
      config = await core.loadConfig();
    } catch {
      config = await core.loadConfig({ github: { owner: workspace.repoOwner, repo: workspace.repoName, token: '' } });
    }
    config.github.owner = workspace.repoOwner;
    config.github.repo = workspace.repoName;

    const github = new core.GitHubService(config);
    const meta = store.getMeta();

    const issues = meta.lastSyncedAt
      ? await github.fetchIssuesSince(meta.lastSyncedAt, false)
      : await github.fetchAllIssues(false);

    let created = 0;
    let updated = 0;
    for (const issue of issues) {
      const result = store.upsertIssue(issue);
      if (result.action === 'created') created++;
      if (result.action === 'updated') updated++;
    }
    store.updateMeta({ lastSyncedAt: new Date().toISOString(), totalFetched: issues.length });
    await store.save();

    const needDigest = store.getIssues({ hasDigest: false });
    let digested = 0;
    if (needDigest.length > 0) {
      const llm = new core.LLMService(config);
      const issueData = needDigest.map((i) => ({ number: i.number, title: i.title, body: i.body }));
      const results = await llm.generateDigests(issueData, config.sync.digestBatchSize);
      for (const [number, digest] of results) {
        store.setDigest(number, digest);
        digested++;
      }
      await store.save();
    }

    const needComments = store.getIssues({ state: 'open' }).filter((i: any) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      const commentMap = await github.fetchCommentsForIssues(needComments.map((i: any) => i.number));
      for (const [num, comments] of commentMap) {
        store.setComments(num, comments);
      }
      await store.save();
    }

    revalidatePath('/dashboard');
    revalidatePath('/issues');
    return { ok: true, fetched: created + updated, digested };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
