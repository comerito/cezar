-- Stores agent-proposed effects awaiting a human decision.
--
-- Populated by `actions-v2/runner.ts` when the producing action's
-- `acceptance_mode='human-in-the-loop'` and the model's self-reported
-- confidence falls in the autoDenyBelow..autoAcceptAbove band defined in
-- `actions.confidence_config` (migration 0018).
--
-- Drained by `acceptDecision(id)` / `dismissDecision(id)` in
-- `app/inbox/decision-actions.ts`. Accept re-fires the captured
-- (effect, effect_args) through the EFFECT_REGISTRY; dismiss just marks
-- the row.
--
-- See docs/REFACTOR-PLAN-inbox-and-acceptance.md §5 for design rationale.

create table pending_decisions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  action_id       uuid not null references actions(id)    on delete cascade,
  workflow_run_id uuid          references workflow_runs(id) on delete set null,
  agent_run_id    uuid          references agent_runs(id)    on delete set null,

  -- Denormalised target identity so the inbox renders without a join.
  -- Exactly one of issue_number / pr_number is set, matched by target_kind.
  target_kind     text    not null check (target_kind in ('issue','pr')),
  issue_number    integer,
  pr_number       integer,
  target_title    text    not null,

  -- The captured effect — name + args. Re-fires verbatim on accept.
  effect          text    not null,
  effect_args     jsonb   not null default '{}'::jsonb,
  summary         text    not null,
  confidence      integer not null check (confidence between 0 and 100),

  status          text    not null default 'pending'
                    check (status in ('pending','accepted','dismissed','expired')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id),
  decided_reason  text,
  apply_error     text,
  expires_at      timestamptz,

  -- Postgres can't enforce "exactly one of issue_number / pr_number" at
  -- column level; encode it here.
  constraint pending_decisions_target_consistency check (
    (target_kind = 'issue' and issue_number is not null and pr_number is null) or
    (target_kind = 'pr'    and pr_number    is not null and issue_number is null)
  )
);

-- Hot path: inbox "give me all pending rows in this workspace, newest first".
create index pending_decisions_workspace_status_idx
  on pending_decisions(workspace_id, status, created_at desc);

-- Used by the inbox grouper and by the runner to look up "is there already a
-- pending decision for (action, issue, effect)?" — useful later for dedupe.
create index pending_decisions_workspace_issue_idx
  on pending_decisions(workspace_id, issue_number)
  where status = 'pending';

alter table pending_decisions enable row level security;

-- Members can read all pending decisions in their workspace.
create policy "pending_decisions_member_select"
  on pending_decisions
  for select
  using (is_workspace_member(workspace_id));

-- Only admins write (the runner uses the service-role client which bypasses
-- RLS entirely; this policy only governs the GUI server actions).
create policy "pending_decisions_admin_insert"
  on pending_decisions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = pending_decisions.workspace_id
        and wm.user_id      = auth.uid()
        and wm.role         = 'admin'
    )
  );

create policy "pending_decisions_admin_update"
  on pending_decisions
  for update
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = pending_decisions.workspace_id
        and wm.user_id      = auth.uid()
        and wm.role         = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = pending_decisions.workspace_id
        and wm.user_id      = auth.uid()
        and wm.role         = 'admin'
    )
  );

comment on table pending_decisions is
  'Agent-proposed effects awaiting a human decision. See
   docs/REFACTOR-PLAN-inbox-and-acceptance.md.';

comment on column pending_decisions.effect is
  'EffectName from actions-v2/effects.ts EFFECT_REGISTRY.';

comment on column pending_decisions.effect_args is
  'Effect-specific argument shape — validated by the registry on accept.';

comment on column pending_decisions.confidence is
  'Model-self-reported confidence in 0..100. Routed against the producing
   action`s confidence_config thresholds.';

comment on column pending_decisions.apply_error is
  'Non-null when acceptDecision failed to execute the effect. Row stays at
   status=pending so the user can retry or dismiss.';
