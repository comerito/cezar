-- Agent-cockpit refactor — Phase 3c (job dispatcher).
-- Adds the SQL side of the dispatcher described in docs/REFACTOR-PLAN-agent-cockpit.md
-- §3.7: a tiny Vercel cron claims queued `jobs` (FOR UPDATE SKIP LOCKED so
-- concurrent ticks don't double-claim) and fires off their workflow runs, plus
-- a watchdog that re-queues `claimed`/`running` jobs that have gone stale (the
-- proper long-running runner is Phase 4 — until then a dispatch tick can die
-- mid-run on serverless, so the watchdog is the safety net).
--
-- `claimed_by_runner` stays NULL in Phase 3 — Phase 4's container runner sets it.

-- ─── claim_next_job ─────────────────────────────────────────────────────
-- Atomically grabs up to p_limit queued, due jobs and marks them 'claimed'
-- (bumping `attempts`). Highest priority first, then oldest scheduled.
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
      order by priority desc, scheduled_at asc
      limit p_limit
      for update skip locked
   )
  returning *;
$$;

-- ─── requeue_stalled_jobs ───────────────────────────────────────────────
-- Watchdog: any job stuck in 'claimed'/'running' past p_stale_minutes is
-- re-queued (or marked 'failed' once it's burned through max_attempts).
-- Returns the number of rows touched.
create or replace function requeue_stalled_jobs(p_stale_minutes int default 15)
returns int
language plpgsql
as $$
declare
  n int;
begin
  update jobs
     set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
         updated_at = now()
   where status in ('claimed', 'running')
     and updated_at < now() - make_interval(mins => p_stale_minutes);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The crons run with the service-role key (bypasses RLS). Granting to all three
-- roles keeps these callable from anywhere a Supabase client reaches; the body
-- of each function is the access-control surface, not who may invoke it.
grant execute on function claim_next_job(int) to anon, authenticated, service_role;
grant execute on function requeue_stalled_jobs(int) to anon, authenticated, service_role;
