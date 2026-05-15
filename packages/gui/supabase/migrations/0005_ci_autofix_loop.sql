-- CI auto-adjust loop (Phase 2).
-- When attribution says verdict='ours', the ci-fix cron spawns a follow-up
-- autofix attempt that pushes new commits to the existing PR branch.
-- ci_fix_attempts caps the loop; ci_fix_in_progress serialises.

alter table flows
  add column ci_fix_attempts     integer not null default 0,
  add column ci_fix_in_progress  boolean not null default false;

-- Index supports the ci-fix cron's claim query:
--   select … from flows
--   where ci_attribution->>'verdict' = 'ours'
--     and ci_fix_in_progress = false
--     and ci_fix_attempts < <max>
create index flows_ci_fix_idx on flows(ci_fix_in_progress, ci_fix_attempts)
  where ci_attribution is not null;
