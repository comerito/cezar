-- Agent-cockpit refactor — Phase 4a (self-hosted/cloud runner HTTP API).
-- Adds the SQL side of `packages/runner` + the `/api/runner/*` routes:
--   * claim_next_job_for_runner   — a runner claims jobs it can serve, stamping
--                                   `claimed_by_runner` so the watchdog can
--                                   re-queue them if the runner dies.
--   * claim_next_job              — SUPERSEDES the 0009 definition: the cron
--                                   (cloud/serverless) now only claims jobs the
--                                   cloud side runs, i.e. `required_backend` is
--                                   NULL or 'anthropic-api'. Everything else is
--                                   for self-hosted runners (claude-cli/codex-cli).
--   * requeue_jobs_for_offline_runners — marks self-hosted runners offline once
--                                   their heartbeat lapses and re-queues (or
--                                   fails) the jobs they were holding.
-- See docs/REFACTOR-PLAN-agent-cockpit.md §3.7, §3.8, §4 (Phase 4).
--
-- Migration-safe: we re-state the full `create or replace function` for
-- `claim_next_job` here rather than editing 0009.

-- ─── claim_next_job_for_runner ──────────────────────────────────────────
-- A runner atomically claims up to p_limit queued, due jobs whose
-- `required_backend` is NULL or one of the backends the runner advertises.
-- Stamps `claimed_by_runner` so `requeue_jobs_for_offline_runners` can find
-- jobs orphaned by a dead runner.
create or replace function claim_next_job_for_runner(p_runner_id uuid, p_backends text[], p_limit int default 1)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = p_runner_id,
         attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= now()
        and (required_backend is null or required_backend = any(p_backends))
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ─── claim_next_job — supersedes the 0009 definition ────────────────────
-- The cron dispatcher (cloud/serverless) must NOT pick up jobs that need a
-- subscription CLI — those belong to self-hosted runners. So restrict the
-- cron's claim to `required_backend` NULL or 'anthropic-api'. `claimed_by_runner`
-- stays NULL for cron-claimed jobs (unchanged from 0009 otherwise).
create or replace function claim_next_job(p_limit int default 1)
returns setof jobs
language sql
as $$
  update jobs
     set status = 'claimed',
         claimed_by_runner = null,
         attempts = attempts + 1,
         updated_at = now()
   where id in (
     select id
       from jobs
      where status = 'queued'
        and scheduled_at <= now()
        and (required_backend is null or required_backend = 'anthropic-api')
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ─── touch_runner_heartbeat ─────────────────────────────────────────────
-- Tiny helper so the runner API routes can refresh a runner's heartbeat in one
-- round-trip. (A plain UPDATE works too — this just keeps callers terse.)
create or replace function touch_runner_heartbeat(p_runner_id uuid, p_status text default 'online')
returns void
language sql
as $$
  update runners
     set last_heartbeat_at = now(),
         status = coalesce(p_status, status),
         updated_at = now()
   where id = p_runner_id;
$$;

-- ─── requeue_jobs_for_offline_runners ───────────────────────────────────
-- Watchdog companion to requeue_stalled_jobs: any self-hosted runner whose
-- heartbeat is older than p_stale_minutes is marked 'offline'; the jobs it was
-- holding ('claimed'/'running') are re-queued (or 'failed' once they've burned
-- through max_attempts). Returns the number of jobs touched.
create or replace function requeue_jobs_for_offline_runners(p_stale_minutes int default 3)
returns int
language plpgsql
as $$
declare
  n int;
begin
  update runners
     set status = 'offline',
         updated_at = now()
   where kind = 'self-hosted'
     and status <> 'offline'
     and (last_heartbeat_at is null or last_heartbeat_at < now() - make_interval(mins => p_stale_minutes));

  update jobs
     set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
         claimed_by_runner = null,
         updated_at = now()
   where status in ('claimed', 'running')
     and claimed_by_runner is not null
     and claimed_by_runner in (select id from runners where status = 'offline');
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The runner API routes run with the service-role key (bypasses RLS); the
-- function bodies are the access-control surface, not who may invoke them.
grant execute on function claim_next_job_for_runner(uuid, text[], int) to anon, authenticated, service_role;
grant execute on function claim_next_job(int) to anon, authenticated, service_role;
grant execute on function touch_runner_heartbeat(uuid, text) to anon, authenticated, service_role;
grant execute on function requeue_jobs_for_offline_runners(int) to anon, authenticated, service_role;
