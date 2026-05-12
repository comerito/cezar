import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { upsertIssueFromWebhook, type WebhookIssue } from '@/lib/upsert-issue-from-webhook';
import type { Database } from '@/lib/supabase/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Phase 5 — the GitHub App webhook receiver (docs §3.7). Verifies the
 * `X-Hub-Signature-256` HMAC, then dispatches on `X-GitHub-Event`:
 *
 *   - `issues` (opened / reopened / title-or-body edited): upsert the issue into
 *     the matching workspace(s) and enqueue a (deduped) `triage` job. The
 *     `/api/cron/dispatch` cron / a self-hosted runner drains it.
 *   - `check_run` (completed/failure): no-op — the ci-watch/ci-attribute/ci-fix
 *     crons already drive the CI follow-up loop (it needs an attribution seed
 *     they produce). TODO(phase-5): convert that to webhook-driven jobs.
 *   - `pull_request`: no-op — the issue-match cron handles PR↔issue linking.
 *     TODO(phase-5).
 *   - `installation` / `installation_repositories`: best-effort record the
 *     installation id on the matching workspace(s).
 *   - `ping` → `{ ok: true }`. Anything else → `{ ignored: true }`.
 *
 * Always responds fast — no agent work happens here. Without
 * `GITHUB_APP_WEBHOOK_SECRET` set it returns 503 (so a missing setup is
 * obvious; the `/api/cron/triage-sweep` poll is the fallback in that case).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'webhook secret not configured' }, { status: 503 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: 'unreadable body' }, { status: 400 });
  }

  const signature = req.headers.get('x-hub-signature-256') ?? '';
  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }

  const event = req.headers.get('x-github-event') ?? '';

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  try {
    const admin = createSupabaseAdminClient();
    switch (event) {
      case 'ping':
        return NextResponse.json({ ok: true });
      case 'issues':
        return await handleIssues(admin, payload);
      case 'check_run':
        // TODO(phase-5): the ci-watch/ci-attribute/ci-fix crons already drive the
        // CI follow-up loop; converting it to webhook-driven jobs is a follow-up.
        // For now, no-op (return 200).
        return NextResponse.json({ ok: true, ignored: 'check_run handled by ci-* crons' });
      case 'pull_request':
        // TODO(phase-5): PR↔issue linking is the issue-match cron's job; no-op here.
        return NextResponse.json({ ok: true, ignored: 'pull_request handled by issue-match cron' });
      case 'installation':
      case 'installation_repositories':
        return await handleInstallation(admin, payload);
      default:
        return NextResponse.json({ ignored: true, event });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[github-webhook] ${event} handler failed:`, msg);
    return NextResponse.json({ error: 'handler error' }, { status: 500 });
  }
}

// ─── signature ──────────────────────────────────────────────────────────────

function verifySignature(rawBody: string, headerValue: string, secret: string): boolean {
  if (!headerValue.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
  const a = Buffer.from(headerValue, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── payload shapes (the slices we touch) ───────────────────────────────────

interface WebhookPayload {
  action?: string;
  changes?: { title?: unknown; body?: unknown };
  issue?: WebhookIssue;
  repository?: { name: string; owner: { login: string } };
  installation?: { id: number };
}

// ─── issues ─────────────────────────────────────────────────────────────────

const TRIAGE_ACTIONS = new Set(['opened', 'reopened']);

async function handleIssues(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  const action = payload.action ?? '';
  const relevant =
    TRIAGE_ACTIONS.has(action) ||
    (action === 'edited' && !!payload.changes && ('title' in payload.changes || 'body' in payload.changes));
  if (!relevant) return NextResponse.json({ ok: true, ignored: `issues.${action}` });

  const issue = payload.issue;
  const repo = payload.repository;
  if (!issue || !repo) return NextResponse.json({ ok: true, ignored: 'issues event missing issue/repository' });

  const workspaces = await resolveWorkspaces(admin, payload, repo);
  if (workspaces.length === 0) return NextResponse.json({ ok: true, ignored: 'no matching workspace' });

  const repoSlug = `${repo.owner.login}/${repo.name}`;
  let enqueued = 0;
  for (const ws of workspaces) {
    if (!ws.auto_triage_enabled) continue;
    try {
      await upsertIssueFromWebhook(admin, ws.id, issue);
    } catch (err) {
      console.error(`[github-webhook] issue upsert failed for ws ${ws.id}:`, err instanceof Error ? err.message : err);
      continue;
    }
    // dedupe: skip if a triage job for this issue is already in flight.
    const { data: open } = await admin
      .from('jobs')
      .select('id')
      .eq('workspace_id', ws.id)
      .eq('kind', 'triage')
      .eq('issue_number', issue.number)
      .in('status', ['queued', 'claimed', 'running'])
      .limit(1);
    if (open && open.length > 0) continue;
    const { error } = await admin.from('jobs').insert({
      workspace_id: ws.id,
      repo: repoSlug,
      kind: 'triage',
      issue_number: issue.number,
      pr_number: null,
      priority: 5,
      status: 'queued',
      max_attempts: 1,
      payload: { trigger: 'webhook', action },
    });
    if (error) {
      console.error(`[github-webhook] triage enqueue failed for ws ${ws.id}:`, error.message);
      continue;
    }
    enqueued++;
  }
  return NextResponse.json({ ok: true, enqueued, workspaces: workspaces.length });
}

// ─── installation ───────────────────────────────────────────────────────────

async function handleInstallation(admin: SupabaseAdmin, payload: WebhookPayload): Promise<NextResponse> {
  const action = payload.action ?? '';
  const installationId = payload.installation?.id;
  const repo = payload.repository;
  try {
    if (action === 'created' || action === 'added') {
      if (installationId != null && repo) {
        await admin
          .from('workspaces')
          .update({ installation_id: String(installationId) })
          .eq('repo_owner', repo.owner.login)
          .eq('repo_name', repo.name);
      }
    } else if (action === 'deleted' || action === 'removed') {
      if (installationId != null) {
        await admin.from('workspaces').update({ installation_id: null }).eq('installation_id', String(installationId));
      } else if (repo) {
        await admin.from('workspaces').update({ installation_id: null }).eq('repo_owner', repo.owner.login).eq('repo_name', repo.name);
      }
    }
  } catch (err) {
    console.error('[github-webhook] installation update failed:', err instanceof Error ? err.message : err);
  }
  return NextResponse.json({ ok: true });
}

// ─── workspace resolution ───────────────────────────────────────────────────

type SupabaseAdmin = ReturnType<typeof createSupabaseAdminClient>;
type WorkspaceMatch = Pick<Database['public']['Tables']['workspaces']['Row'], 'id' | 'auto_triage_enabled'>;

/** Match by `installation_id` first (preferred), else by `repo_owner`/`repo_name`. */
async function resolveWorkspaces(
  admin: SupabaseAdmin,
  payload: WebhookPayload,
  repo: { name: string; owner: { login: string } },
): Promise<WorkspaceMatch[]> {
  const installationId = payload.installation?.id;
  if (installationId != null) {
    const { data } = await admin
      .from('workspaces')
      .select('id, auto_triage_enabled')
      .eq('installation_id', String(installationId));
    if (data && data.length > 0) return data;
  }
  const { data } = await admin
    .from('workspaces')
    .select('id, auto_triage_enabled')
    .eq('repo_owner', repo.owner.login)
    .eq('repo_name', repo.name);
  return data ?? [];
}
