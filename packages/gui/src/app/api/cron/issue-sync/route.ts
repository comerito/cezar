import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Cap per-tick work so one oversized repo can't blow the cron timeout.
// Bug-labeled open issues are usually a short list, but PR volume can spike.
const MAX_WORKSPACES_PER_TICK = 10;

type Workspace = {
  id: string;
  repo_owner: string;
  repo_name: string;
  issue_autofix_mode: 'off' | 'notify' | 'autonomous';
};

export async function GET(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${expected}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const supabase = createSupabaseAdminClient();

  const { data: workspaces, error } = await supabase
    .from('workspaces')
    .select('id, repo_owner, repo_name, issue_autofix_mode')
    .neq('issue_autofix_mode', 'off')
    .limit(MAX_WORKSPACES_PER_TICK);

  if (error) {
    console.error('[issue-sync] workspace query failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  const core = await import('@cezar/core');
  const results = await Promise.all(
    (workspaces as Workspace[]).map(async (ws) => {
      try {
        return await syncOne(ws, supabase, core);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[issue-sync] workspace ${ws.id} failed:`, msg);
        return { workspaceId: ws.id, ok: false, error: msg };
      }
    }),
  );

  return NextResponse.json({ processed: workspaces.length, results });
}

async function syncOne(
  ws: Workspace,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
  core: typeof import('@cezar/core'),
): Promise<{ workspaceId: string; ok: true; bugs: number; prs: number; newCandidates: number }> {
  const token = await resolveWorkspaceToken(ws.id, supabase);
  if (!token) throw new Error('no github token available for workspace');

  const github = new core.GitHubService({
    github: { owner: ws.repo_owner, repo: ws.repo_name, token },
  } as any);

  const [openIssues, openPRs] = await Promise.all([
    github.fetchAllIssues(false),
    github.listOpenPullRequests(),
  ]);

  // Upsert bug-labeled issues. Non-bug issues are ignored — the loop only
  // cares about the bug list, and full sync already has its own path.
  const bugIssues = openIssues.filter(i => i.labels.includes('bug'));

  if (bugIssues.length > 0) {
    const rows = bugIssues.map(i => ({
      workspace_id: ws.id,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      labels: i.labels,
      assignees: i.assignees,
      author: i.author,
      html_url: i.htmlUrl,
      content_hash: i.contentHash,
      comment_count: i.commentCount,
      reactions: i.reactions,
    }));
    const { error: upsertErr } = await supabase
      .from('issues')
      .upsert(rows as any, { onConflict: 'workspace_id,number' });
    if (upsertErr) throw new Error(`issues upsert failed: ${upsertErr.message}`);
  }

  if (openPRs.length > 0) {
    const prRows = openPRs.map(p => ({
      workspace_id: ws.id,
      number: p.number,
      title: p.title,
      body: p.body,
      state: p.state,
      author: p.author,
      html_url: p.htmlUrl,
      head_sha: p.headSha,
      head_ref: p.headRef,
      base_ref: p.baseRef,
      referenced_issues: p.referencedIssues,
    }));
    const { error: prErr } = await supabase
      .from('pull_requests')
      .upsert(prRows as any, { onConflict: 'workspace_id,number' });
    if (prErr) throw new Error(`pull_requests upsert failed: ${prErr.message}`);
  }

  // Seed candidate rows for bug issues that don't have one yet.
  // onConflict do-nothing via upsert with ignoreDuplicates.
  let newCandidates = 0;
  if (bugIssues.length > 0) {
    const candidateRows = bugIssues.map(i => ({
      workspace_id: ws.id,
      issue_number: i.number,
      status: 'pending_match' as const,
    }));
    const { data: inserted, error: candErr } = await supabase
      .from('issue_autofix_candidates')
      .upsert(candidateRows as any, {
        onConflict: 'workspace_id,issue_number',
        ignoreDuplicates: true,
      })
      .select('id');
    if (candErr) throw new Error(`candidates upsert failed: ${candErr.message}`);
    newCandidates = inserted?.length ?? 0;
  }

  return {
    workspaceId: ws.id,
    ok: true,
    bugs: bugIssues.length,
    prs: openPRs.length,
    newCandidates,
  };
}

// Picks a workable GitHub token for the workspace: walk admins, return the
// first one whose provider_token is stored. Falls back to the env-level
// GITHUB_TOKEN so single-tenant self-hosted deployments still work.
async function resolveWorkspaceToken(
  workspaceId: string,
  supabase: ReturnType<typeof createSupabaseAdminClient>,
): Promise<string | null> {
  const { data: admins } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'admin');

  if (admins && admins.length > 0) {
    const ids = admins.map(a => a.user_id);
    const { data: tokens } = await supabase
      .from('user_github_tokens')
      .select('provider_token')
      .in('user_id', ids)
      .limit(1);
    const token = tokens?.[0]?.provider_token;
    if (token) return token;
  }

  return process.env.GITHUB_TOKEN || null;
}
