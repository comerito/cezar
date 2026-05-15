-- CI watch (Phase 0).
-- Adds the fields the Vercel cron poller needs to track CI status on the
-- PR opened by an autofix flow. Existing flow_status values are reused:
-- a flow stays in 'pr-opened' while CI is pending/resolving; ci_status is
-- an orthogonal dimension.

alter table flows
  add column head_sha        text,
  add column ci_status       text,
  add column ci_checked_at   timestamptz,
  add column ci_failed_checks jsonb not null default '[]'::jsonb;

-- Allowed ci_status values: 'pending' | 'success' | 'failure' | 'neutral' | 'unknown'
-- Left as text (not enum) so Phase 1/2 can add values without a migration.
alter table flows
  add constraint flows_ci_status_chk
  check (ci_status is null or ci_status in ('pending','success','failure','neutral','unknown'));

-- Index supports the cron poller:
--   select … from flows
--   where status = 'pr-opened'
--     and head_sha is not null
--     and (ci_status is null or ci_status = 'pending')
create index flows_ci_watch_idx on flows(status, ci_status)
  where head_sha is not null;
