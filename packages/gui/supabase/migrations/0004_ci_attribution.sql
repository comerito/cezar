-- CI attribution (Phase 1).
-- After ci-watch marks a flow as 'failure', the attribution worker decides
-- whether the failure was caused by the autofix change ('ours'), is a
-- pre-existing / infra issue ('unrelated'), looks flaky, or is unsure.
-- Each attempt is serialised via the in_progress lock.

alter table flows
  add column ci_attribution              jsonb,
  add column ci_attribution_checked_at   timestamptz,
  add column ci_flaky_reruns             integer not null default 0,
  add column ci_attribution_in_progress  boolean not null default false;

-- Index supports the attribution worker:
--   select … from flows
--   where ci_status = 'failure'
--     and ci_attribution is null
--     and ci_attribution_in_progress = false
create index flows_ci_attribute_idx on flows(ci_status, ci_attribution_in_progress)
  where ci_status = 'failure' and ci_attribution is null;
