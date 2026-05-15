-- Local-dev seed: create a synthetic flow row pointing at a real PR so the
-- CI watch / attribute / fix cron endpoints have something to act on.
--
-- How to use:
--   1. Pick a real open PR you control — it's what the watcher will poll.
--   2. Fill in the :variable values below. In psql:
--        \set ws_slug       'open-mercato-v2'
--        \set user_email    'you@example.com'
--        \set repo_owner    'open-mercato'
--        \set repo_name     'open-mercato'
--        \set pr_number     42
--        \set pr_head_sha   'abc123...'  -- git rev-parse origin/<pr-branch>
--        \set pr_branch     'autofix/cezar-issue-9999'
--        \set issue_number  9999
--        \i packages/gui/supabase/seeds/seed-ci-flow.sql
--
--   Or via the Supabase SQL editor: replace each :'var' with a literal
--   ('my-workspace', 42, etc.) and paste the rest.
--
-- This script is idempotent on (workspace, issue_number) — re-running resets
-- the row so you can cycle the flow through watch → attribute → fix again.

begin;

-- Resolve foreign keys from human-readable inputs.
with
  ws as (select id from workspaces where slug = :'ws_slug'),
  usr as (select id from auth.users where email = :'user_email')
insert into flows (
  workspace_id, actor_id, issue_number, status, mode,
  branch, pr_url, pr_number, head_sha,
  ci_status, ci_failed_checks,
  ci_attribution, ci_attribution_in_progress, ci_flaky_reruns,
  ci_fix_attempts, ci_fix_in_progress
)
select
  ws.id,
  usr.id,
  :issue_number,
  'pr-opened'::flow_status,
  'apply'::flow_mode,
  :'pr_branch',
  'https://github.com/' || :'repo_owner' || '/' || :'repo_name' || '/pull/' || :pr_number,
  :pr_number,
  :'pr_head_sha',
  'pending',     -- watcher picks this up on the next tick
  '[]'::jsonb,
  null,          -- attribution cron writes this once CI resolves to failure
  false,
  0,
  0,
  false
from ws, usr
on conflict do nothing;

-- If a seed row already exists for this (workspace, issue) pair, reset it
-- so re-running exercises the loop from scratch.
update flows f
   set status                     = 'pr-opened',
       mode                       = 'apply',
       branch                     = :'pr_branch',
       pr_url                     = 'https://github.com/' || :'repo_owner' || '/' || :'repo_name' || '/pull/' || :pr_number,
       pr_number                  = :pr_number,
       head_sha                   = :'pr_head_sha',
       ci_status                  = 'pending',
       ci_checked_at              = null,
       ci_failed_checks           = '[]'::jsonb,
       ci_attribution             = null,
       ci_attribution_checked_at  = null,
       ci_attribution_in_progress = false,
       ci_flaky_reruns            = 0,
       ci_fix_attempts            = 0,
       ci_fix_in_progress         = false,
       outcome                    = null,
       updated_at                 = now()
  from workspaces w, auth.users u
 where f.workspace_id = w.id
   and f.actor_id     = u.id
   and w.slug         = :'ws_slug'
   and u.email        = :'user_email'
   and f.issue_number = :issue_number;

-- Show the seeded row so you can grab its id for curl/browser checks.
select id, workspace_id, actor_id, issue_number, status, ci_status, head_sha, pr_url
  from flows f
  join workspaces w on w.id = f.workspace_id
  join auth.users u on u.id = f.actor_id
 where w.slug         = :'ws_slug'
   and u.email        = :'user_email'
   and f.issue_number = :issue_number;

commit;
