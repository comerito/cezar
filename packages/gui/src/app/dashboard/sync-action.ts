'use server';

import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SupabaseStoreAdapter } from '@/lib/adapters/supabase-store';
import { loadWorkspaceConfig } from '@/lib/load-workspace-config';

export async function startSync(): Promise<{ ok: boolean; error?: string; syncId?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: 'Not authenticated' };
  const workspace = await getActiveWorkspace();
  if (!workspace) return { ok: false, error: 'No workspace selected' };

  const githubToken = user.githubToken || process.env.GITHUB_TOKEN || '';
  if (!githubToken) return { ok: false, error: 'No GitHub token — sign out and back in to refresh' };

  const syncId = `sync-${workspace.id}-${Date.now()}`;

  runSyncInBackground(syncId, workspace.id, workspace.repoOwner, workspace.repoName, githubToken).catch((err) => {
    console.error(`[sync ${syncId}] crashed:`, err);
  });

  return { ok: true, syncId };
}

async function runSyncInBackground(
  syncId: string,
  workspaceId: string,
  repoOwner: string,
  repoName: string,
  githubToken: string,
) {
  const supabase = createSupabaseAdminClient();
  const channel = supabase.channel(syncId);
  await channel.subscribe();

  function emit(stage: string, message: string, current?: number, total?: number) {
    channel.send({ type: 'broadcast', event: 'progress', payload: { stage, message, current, total } });
  }

  try {
    emit('init', 'Loading workspace...');
    const core = await import('@cezar/core');
    const adapter = new SupabaseStoreAdapter(supabase, workspaceId);

    let store: Awaited<ReturnType<typeof core.IssueStore.fromPort>>;
    try {
      store = await core.IssueStore.fromPort(adapter);
    } catch {
      store = await core.IssueStore.fromPort({
        async load() {
          return {
            meta: { owner: repoOwner, repo: repoName, lastSyncedAt: null, totalFetched: 0, version: 1 as const, orgMembers: [], orgMembersFetchedAt: null },
            issues: [],
          };
        },
        async save(data) { await adapter.save(data); },
      });
    }

    const config = await loadWorkspaceConfig(workspaceId, supabase, {
      githubToken,
      repoOwner,
      repoName,
    });

    // Fetch issues
    emit('fetch', 'Fetching issues from GitHub...');
    const github = new core.GitHubService(config);
    const meta = store.getMeta();
    const issues = meta.lastSyncedAt
      ? await github.fetchIssuesSince(meta.lastSyncedAt, false)
      : await github.fetchAllIssues(false);

    let created = 0, updated = 0;
    for (const issue of issues) {
      const r = store.upsertIssue(issue);
      if (r.action === 'created') created++;
      if (r.action === 'updated') updated++;
    }
    store.updateMeta({ lastSyncedAt: new Date().toISOString(), totalFetched: issues.length });
    emit('fetch', `Fetched ${issues.length} issues (${created} new, ${updated} updated)`);
    await store.save();

    // Digest
    const needDigest = store.getIssues({ hasDigest: false });
    if (needDigest.length > 0) {
      emit('digest', `Generating digests for ${needDigest.length} issues...`, 0, needDigest.length);
      const llm = new core.LLMService(config);
      const issueData = needDigest.map((i: any) => ({ number: i.number, title: i.title, body: i.body }));
      let digested = 0;
      const results = await llm.generateDigests(issueData, config.sync.digestBatchSize, (done: number, total: number) => {
        digested = done;
        emit('digest', `Digesting issues... ${done}/${total}`, done, total);
      });
      for (const [number, digest] of results) {
        store.setDigest(number, digest);
      }
      emit('digest', `Digested ${results.size} issues`);
      await store.save();
    } else {
      emit('digest', 'All issues already digested');
    }

    // Comments
    const needComments = store.getIssues({ state: 'open' }).filter((i: any) => !i.commentsFetchedAt && i.commentCount > 0);
    if (needComments.length > 0) {
      emit('comments', `Fetching comments for ${needComments.length} issues...`, 0, needComments.length);
      const commentMap = await github.fetchCommentsForIssues(
        needComments.map((i: any) => i.number),
        (done: number, total: number) => emit('comments', `Fetching comments... ${done}/${total}`, done, total),
      );
      for (const [num, comments] of commentMap) {
        store.setComments(num, comments);
      }
      await store.save();
      emit('comments', `Fetched comments for ${commentMap.size} issues`);
    }

    emit('done', `Sync complete — ${issues.length} issues, ${needDigest.length} digested`);
  } catch (err) {
    emit('error', (err as Error).message);
  } finally {
    setTimeout(() => supabase.removeChannel(channel), 5000);
  }
}
