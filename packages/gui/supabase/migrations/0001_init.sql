-- Initial schema for @cezar/gui.
-- Tables mirror the shape documented in CEZAR-GUI-SPEC.md §6.2.
-- RLS policies mirror §4.5 — actors see only their own flows; admins see all
-- flows in their workspace.

-- ─── Extensions ─────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ─── Enums ──────────────────────────────────────────────────────────────
create type workspace_role as enum ('admin', 'actor', 'viewer');
create type issue_state   as enum ('open', 'closed');
create type flow_status   as enum ('pending', 'running', 'succeeded', 'failed', 'skipped', 'pr-opened');
create type flow_mode     as enum ('apply', 'dry-run');
create type flow_event_kind as enum ('lifecycle', 'agent');

-- ─── workspaces ─────────────────────────────────────────────────────────
create table workspaces (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,
  name            text not null,
  repo_owner      text not null,
  repo_name       text not null,
  installation_id text,
  config          jsonb not null default '{}'::jsonb,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint workspaces_repo_unique unique (repo_owner, repo_name)
);

-- ─── workspace_members ──────────────────────────────────────────────────
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         workspace_role not null default 'actor',
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index workspace_members_user_idx on workspace_members(user_id);

-- Helper: is the current user an admin of this workspace?
create or replace function is_workspace_admin(wid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = wid
      and user_id = auth.uid()
      and role = 'admin'
  );
$$;

-- Helper: is the current user any member of this workspace?
create or replace function is_workspace_member(wid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from workspace_members
    where workspace_id = wid
      and user_id = auth.uid()
  );
$$;

-- ─── issues (CEZAR store, per workspace) ────────────────────────────────
create table issues (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  number              integer not null,
  title               text not null,
  body                text not null default '',
  state               issue_state not null,
  labels              text[] not null default '{}',
  assignees           text[] not null default '{}',
  author              text not null,
  html_url            text not null,
  content_hash        text not null,
  comment_count       integer not null default 0,
  reactions           integer not null default 0,
  comments            jsonb not null default '[]'::jsonb,
  comments_fetched_at timestamptz,
  digest              jsonb,
  analysis            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint issues_workspace_number_unique unique (workspace_id, number)
);

create index issues_workspace_state_idx on issues(workspace_id, state);

-- ─── flows ──────────────────────────────────────────────────────────────
create table flows (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id     uuid not null references auth.users(id) on delete cascade,
  issue_number integer not null,
  status       flow_status not null default 'pending',
  mode         flow_mode   not null default 'dry-run',
  branch       text,
  pr_url       text,
  pr_number    integer,
  outcome      jsonb,
  attempts     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index flows_workspace_idx on flows(workspace_id);
create index flows_actor_idx on flows(actor_id);
create index flows_status_idx on flows(status);

-- ─── flow_events (audit + live feed via Realtime) ───────────────────────
create table flow_events (
  id         uuid primary key default gen_random_uuid(),
  flow_id    uuid not null references flows(id) on delete cascade,
  type       flow_event_kind not null,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);

create index flow_events_flow_idx on flow_events(flow_id, created_at);

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table workspaces        enable row level security;
alter table workspace_members enable row level security;
alter table issues            enable row level security;
alter table flows             enable row level security;
alter table flow_events       enable row level security;

-- workspaces: members can see, admins can update
create policy "ws_member_select" on workspaces
  for select using (is_workspace_member(id));

create policy "ws_admin_update" on workspaces
  for update using (is_workspace_admin(id)) with check (is_workspace_admin(id));

-- workspace_members: members see the roster of workspaces they belong to
create policy "wm_self_select" on workspace_members
  for select using (is_workspace_member(workspace_id));

create policy "wm_admin_write" on workspace_members
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- issues: visible to any workspace member
create policy "issues_member_select" on issues
  for select using (is_workspace_member(workspace_id));

-- flows: actor sees own; admin sees all in workspace
create policy "flows_actor_select" on flows
  for select using (
    actor_id = auth.uid() or is_workspace_admin(workspace_id)
  );

create policy "flows_actor_insert" on flows
  for insert with check (
    actor_id = auth.uid() and is_workspace_member(workspace_id)
  );

create policy "flows_actor_update" on flows
  for update using (
    actor_id = auth.uid() or is_workspace_admin(workspace_id)
  );

-- flow_events: inherit flow visibility
create policy "flow_events_select" on flow_events
  for select using (
    exists (
      select 1 from flows
      where flows.id = flow_events.flow_id
        and (flows.actor_id = auth.uid() or is_workspace_admin(flows.workspace_id))
    )
  );

-- ─── updated_at trigger ─────────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspaces_touch before update on workspaces
  for each row execute function touch_updated_at();

create trigger issues_touch before update on issues
  for each row execute function touch_updated_at();

create trigger flows_touch before update on flows
  for each row execute function touch_updated_at();
