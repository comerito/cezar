import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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
  const [issueRaw] = process.argv.slice(2);
  const issueNumber = issueRaw ? Number(issueRaw) : 1950;
  const env = loadGuiEnv();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data } = await sb
    .from('workflow_runs')
    .select('id, workflow, status, reason, started_at, finished_at, tokens_used')
    .eq('issue_number', issueNumber)
    .eq('workflow', 'autofix')
    .order('started_at', { ascending: false })
    .limit(10);
  console.log(`recent autofix runs for #${issueNumber}:`);
  for (const r of data ?? []) {
    console.log(`\n  ${r.started_at}  ${r.status}  ${r.tokens_used ?? 0} tok`);
    console.log(`  id    : ${r.id}`);
    console.log(`  reason: ${r.reason ?? '(null)'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
