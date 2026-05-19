/**
 * Diagnostic: dump an issue from the GUI's Supabase store + run
 * detectBugSignal against it. Uses NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY from packages/gui/.env.
 *
 *   npx tsx packages/core/scripts/diag-store-issue.ts <workspaceSlug> <issueNumber>
 *
 * `workspaceSlug` is `repoOwner/repoName` (e.g. `open-mercato/open-mercato`).
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { detectBugSignal } from '../src/actions/autofix/bug-signal.js';
import type { StoredIssue } from '../src/store/store.model.js';

function loadGuiEnv() {
  const text = readFileSync(new URL('../../gui/.env', import.meta.url), 'utf8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

async function main() {
  const [slug, numberRaw] = process.argv.slice(2);
  if (!slug || !numberRaw) {
    console.error('Usage: diag-store-issue.ts <owner/repo> <issueNumber>');
    process.exit(2);
  }
  const issueNumber = Number(numberRaw);
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) {
    console.error('slug must be in the form owner/repo');
    process.exit(2);
  }

  const env = loadGuiEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  // Find the workspace
  const { data: wsRows } = await sb
    .from('workspaces')
    .select('id, repo_owner, repo_name')
    .eq('repo_owner', owner)
    .eq('repo_name', repo);
  if (!wsRows || wsRows.length === 0) {
    console.error(`no workspace for ${slug}`);
    process.exit(1);
  }
  console.log('workspaces matching slug:', wsRows.length);

  for (const ws of wsRows) {
    console.log(`\n── workspace ${ws.id} ─────────────────────────────`);
    const { data: row, error } = await sb
      .from('issues')
      .select('*')
      .eq('workspace_id', ws.id)
      .eq('number', issueNumber)
      .maybeSingle();
    if (error) {
      console.error('  query error:', error.message);
      continue;
    }
    if (!row) {
      console.log(`  #${issueNumber} not in issues table`);
      continue;
    }
    console.log(`  #${issueNumber} title  : ${JSON.stringify(row.title)}`);
    console.log(`  #${issueNumber} state  : ${row.state}`);
    console.log(`  #${issueNumber} labels : ${JSON.stringify(row.labels)}`);
    const analysis = (row.analysis ?? {}) as { issueType?: string | null; bugConfidence?: number | null };
    console.log(`  #${issueNumber} analysis.issueType=${analysis.issueType ?? 'null'} bugConfidence=${analysis.bugConfidence ?? 'null'}`);
    const issue: StoredIssue = {
      number: row.number,
      title: row.title,
      body: row.body ?? '',
      state: row.state,
      labels: row.labels ?? [],
      assignees: [],
      author: row.author ?? 'unknown',
      createdAt: row.created_at ?? new Date().toISOString(),
      updatedAt: row.updated_at ?? new Date().toISOString(),
      htmlUrl: row.html_url ?? '',
      contentHash: row.content_hash ?? 'diag',
      commentCount: row.comment_count ?? 0,
      reactions: row.reactions ?? 0,
      comments: [],
      commentsFetchedAt: null,
      digest: null,
      analysis: analysis as StoredIssue['analysis'],
    };
    const signal = detectBugSignal(issue, { minConfidence: 0.6 });
    console.log(`  → detectBugSignal: isBug=${signal.isBug} reason=${signal.reason}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
