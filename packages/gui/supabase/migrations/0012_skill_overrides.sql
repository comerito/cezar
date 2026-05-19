-- UI refactor — per-skill overrides.
--
-- An *override* is a workspace-scoped copy of a repo-supplied skill. When an
-- override row exists for (workspace_id, skill_name), every consumer prefers
-- it over the upstream `<repo>/.ai/skills/<name>.md` definition. The original
-- stays untouched in `repo_skills` so the user can compare/discard.
--
-- This is distinct from `workflow_bindings`, which now plays the narrower role
-- of "usage settings" — i.e. which skill (by name, possibly an override) is
-- selected for each pipeline step, with backend/model/tool routing.

create table skill_overrides (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  skill_name      text not null,
  -- Full markdown body of the user's copy. Empty string allowed (the user
  -- may have stripped everything; we still treat the override as "the chosen
  -- one" until they discard it).
  body            text not null default '',
  -- Free-form metadata controls surfaced on the detail page.
  execution_mode  text not null default 'continuous',
  triggers        jsonb not null default '[]'::jsonb,
  outputs         jsonb not null default '["stdout.json"]'::jsonb,
  capabilities    jsonb not null default '["reasoning"]'::jsonb,
  -- When false, the override exists but consumers fall back to the original.
  -- Lets the user keep their edits while temporarily disabling them.
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id),
  updated_by      uuid references auth.users(id),
  unique (workspace_id, skill_name)
);

create index skill_overrides_workspace_idx on skill_overrides(workspace_id);

-- Keep updated_at fresh on every UPDATE.
create or replace function skill_overrides_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger skill_overrides_set_updated_at
  before update on skill_overrides
  for each row execute function skill_overrides_set_updated_at();

alter table skill_overrides enable row level security;

-- Any member of the workspace can read its overrides.
create policy "members read skill_overrides"
  on skill_overrides for select
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_overrides.workspace_id
        and wm.user_id = auth.uid()
    )
  );

-- Only admins can create/update/delete overrides.
create policy "admins write skill_overrides"
  on skill_overrides for all
  to authenticated
  using (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_overrides.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from workspace_members wm
      where wm.workspace_id = skill_overrides.workspace_id
        and wm.user_id = auth.uid()
        and wm.role = 'admin'
    )
  );
