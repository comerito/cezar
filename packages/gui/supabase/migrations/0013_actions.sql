-- New action model — replaces the TypeScript action-plugin registry with a
-- data-driven "Action" concept: a system prompt + a set of skill refs (which
-- get pulled into context) + a target (issue or PR) + a list of triggers +
-- an optional declared effects list with an output schema, OR (when effects
-- is null) the runner exposes the effect vocabulary to the agent as tools
-- and lets it call them mid-run.
--
-- Skills stay the building blocks; an Action is the configurable invocation.
-- workflow_bindings is no longer used as the "is this an override?" flag —
-- skill_overrides (migration 0012) owns that. workflow_bindings will be
-- repurposed or retired alongside the legacy actions/* plugin tree in the
-- next commit; this migration only adds the new table.

create table actions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,

  -- machine name (also the route slug). Unique per workspace.
  name            text not null,
  -- 'built-in' = seeded with Cezar, can be overridden (copy+edit) but not
  -- deleted. 'user' = workspace-authored, fully editable.
  kind            text not null check (kind in ('built-in', 'user')) default 'user',

  description     text,
  -- The operative instruction. Plain markdown; sent verbatim as the
  -- Anthropic system message after skill_refs are concatenated.
  system_prompt   text not null default '',
  -- Names of skills to pull in as additional context. Each entry resolves
  -- against built-in + repo + override sources, in that precedence.
  skill_refs      jsonb not null default '[]'::jsonb,

  target          text not null check (target in ('issue', 'pr')),
  -- Multi-trigger: an action can fire on many events.
  --   'manual', 'on-issue-opened', 'on-issue-edited', 'on-issue-reopened',
  --   'on-pr-opened', 'on-pr-edited', 'on-comment', 'on-check-failed',
  --   'on-cron'
  triggers        jsonb not null default '[]'::jsonb,

  -- Declared effects: when non-null, the runner enforces output_schema on
  -- the model response and applies these effects in order. When null, the
  -- runner exposes the effect vocabulary as Anthropic tools so the agent
  -- can call them itself.
  effects         jsonb,
  output_schema   jsonb,

  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_by      uuid references auth.users(id),

  unique (workspace_id, name)
);

create index actions_workspace_idx on actions(workspace_id);
create index actions_workspace_target_idx on actions(workspace_id, target) where enabled = true;

-- Workspace-level pointer to the "main" auto-triage action — the one that
-- runs once per new issue/PR (and on old ones without a triage record).
-- Other actions still apply via their (target, triggers) filter.
alter table workspaces
  add column auto_triage_action_id uuid references actions(id) on delete set null;

create or replace function actions_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger actions_set_updated_at
  before update on actions
  for each row execute function actions_set_updated_at();

alter table actions enable row level security;

create policy "members read actions"
  on actions for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = actions.workspace_id
        and wm.user_id = auth.uid()
    )
  );

-- Built-in actions can be created/seeded by the service role; users can
-- only insert/update/delete actions where kind='user' (and they're admin).
create policy "admins write user actions"
  on actions for all
  to authenticated
  using (
    kind = 'user'
    and exists (
      select 1 from workspace_members wm
      where wm.workspace_id = actions.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    kind = 'user'
    and exists (
      select 1 from workspace_members wm
      where wm.workspace_id = actions.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );

comment on table actions is
  'Data-driven replacement for legacy TypeScript action plugins. Each row is a
   system prompt + skill_refs + target + triggers, optionally with declared
   effects (output_schema enforced) or undeclared (effects exposed as agent
   tools).';

comment on column actions.kind is
  'built-in (seeded with Cezar, immutable name; override by copy+edit) or user
   (workspace-authored, fully editable).';

comment on column workspaces.auto_triage_action_id is
  'The one action that runs once per new issue/PR. NULL = no auto-triage.';
