-- Agent-cockpit refactor — Phase 3a.
-- Adds the job queue + run/event tables that back the (forthcoming) cockpit:
--   * jobs            — the work queue (one row = one unit of work to dispatch).
--   * workflow_runs    — one row per *workflow run* (the whole autofix attempt;
--                        the thing a user pauses/cancels). The clean replacement
--                        for a `flows` row.
--   * agent_runs       — one row per step execution within a workflow run.
--   * agent_run_events — the streamed events for a workflow run's live view.
--   * runners          — managed + self-hosted runners (no UI yet — Phase 4).
-- See docs/REFACTOR-PLAN-agent-cockpit.md §3.4, §3.7, §4 (Phase 3).
--
-- NOTE: `flows` / `flow_events` stay in PARALLEL with these for now — the doc's
-- "`flows` becomes a view over `agent_runs`" is deliberately NOT done here. No
-- view, no backfill: a later migration retires `flows`/`flow_events` once the 6
-- legacy cron route files are gone (Phase 3c/5). Today both schemas coexist;
-- the engine path (config.workflow.useEngine) writes the new tables, the legacy
-- path keeps writing `flows`.

-- ─── jobs ───────────────────────────────────────────────────────────────
create table jobs (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  repo               text,
  kind               text not null check (kind in ('triage','autofix','ci-followup')),
  issue_number       integer,
  pr_number          integer,
  priority           integer not null default 0,
  status             text not null default 'queued'
                       check (status in ('queued','claimed','running','done','failed','cancelled')),
  required_backend   text check (required_backend in ('anthropic-api','claude-cli','codex-cli')),
  claimed_by_runner  uuid,
  attempts           integer not null default 0,
  max_attempts       integer not null default 1,
  scheduled_at       timestamptz not null default now(),
  payload            jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index jobs_workspace_status_idx on jobs(workspace_id, status);
create index jobs_status_scheduled_idx on jobs(status, scheduled_at);

-- ─── workflow_runs ──────────────────────────────────────────────────────
create table workflow_runs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  job_id           uuid references jobs(id) on delete set null,
  workflow         text not null,  -- 'autofix' | 'ci-followup' | 'triage'
  repo             text,
  issue_number     integer,
  pr_number        integer,
  branch           text,
  head_sha         text,
  pr_url           text,
  status           text not null default 'running'
                     check (status in ('queued','running','paused','succeeded','failed','cancelled')),
  pause_requested  boolean not null default false,
  current_step_id  text,
  outcome          jsonb,
  reason           text,
  tokens_used      integer not null default 0,
  cost_estimate    numeric,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index workflow_runs_workspace_status_idx  on workflow_runs(workspace_id, status);
create index workflow_runs_workspace_created_idx on workflow_runs(workspace_id, created_at desc);

-- ─── agent_runs ─────────────────────────────────────────────────────────
create table agent_runs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  workflow_run_id  uuid not null references workflow_runs(id) on delete cascade,
  step_id          text not null,
  iteration        integer not null default 1,
  kind             text,  -- step kind: 'agent'|'effect'|'human-gate'|'commit'|'open-pr'|'push'
  backend          text,
  model            text,
  status           text not null default 'running'
                     check (status in ('running','succeeded','failed','skipped')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  tokens_used      integer not null default 0,
  cost_estimate    numeric,
  summary          text,
  error            text
);

create index agent_runs_run_started_idx on agent_runs(workflow_run_id, started_at);

-- ─── agent_run_events ───────────────────────────────────────────────────
create table agent_run_events (
  id               bigint generated always as identity primary key,
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  workflow_run_id  uuid not null references workflow_runs(id) on delete cascade,
  -- nullable: lifecycle events aren't tied to a specific step.
  agent_run_id     uuid references agent_runs(id) on delete cascade,
  type             text not null,  -- 'lifecycle'|'agent-text'|'tool-call'|'tool-result'|'note'|'step-start'|'step-end'
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create index agent_run_events_run_idx on agent_run_events(workflow_run_id, id);

-- ─── runners ────────────────────────────────────────────────────────────
create table runners (
  id                 uuid primary key default gen_random_uuid(),
  -- null = a managed / global runner (visible to any authenticated user).
  workspace_id       uuid references workspaces(id) on delete cascade,
  name               text not null,
  kind               text not null check (kind in ('cloud','self-hosted')),
  backends           text[] not null default '{}',
  models             text[] not null default '{}',
  token_hash         text,
  status             text not null default 'offline'
                       check (status in ('online','offline','draining')),
  last_heartbeat_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table jobs             enable row level security;
alter table workflow_runs    enable row level security;
alter table agent_runs       enable row level security;
alter table agent_run_events enable row level security;
alter table runners          enable row level security;

-- jobs: members read, admins write. (The dispatcher writes via the service-role
-- key, which bypasses RLS — no special policy needed for it.)
create policy "jobs_member_select" on jobs
  for select using (is_workspace_member(workspace_id));
create policy "jobs_admin_write" on jobs
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- workflow_runs: members read, admins write.
create policy "workflow_runs_member_select" on workflow_runs
  for select using (is_workspace_member(workspace_id));
create policy "workflow_runs_admin_write" on workflow_runs
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- agent_runs: members read, admins write.
create policy "agent_runs_member_select" on agent_runs
  for select using (is_workspace_member(workspace_id));
create policy "agent_runs_admin_write" on agent_runs
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- agent_run_events: members read, admins write. (Cron/dispatcher writes via the
-- service-role key → bypasses RLS, so no extra service-role policy is required.)
create policy "agent_run_events_member_select" on agent_run_events
  for select using (is_workspace_member(workspace_id));
create policy "agent_run_events_admin_write" on agent_run_events
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- runners: members read their workspace's runners + every authenticated user
-- can see managed (workspace_id is null) runners. Admins write workspace runners.
create policy "runners_member_select" on runners
  for select using (workspace_id is null or is_workspace_member(workspace_id));
create policy "runners_admin_write" on runners
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- ─── updated_at triggers (reuse touch_updated_at() from 0001) ───────────
create trigger jobs_touch before update on jobs
  for each row execute function touch_updated_at();
create trigger workflow_runs_touch before update on workflow_runs
  for each row execute function touch_updated_at();
create trigger runners_touch before update on runners
  for each row execute function touch_updated_at();

-- ─── Realtime ───────────────────────────────────────────────────────────
-- The live cockpit subscribes to workflow runs + their events. (0001 did not
-- manage the publication via migration — Realtime tables are added here
-- defensively; if the publication doesn't exist this is a no-op-ish error in
-- some environments, so guard it.)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table workflow_runs;
    alter publication supabase_realtime add table agent_runs;
    alter publication supabase_realtime add table agent_run_events;
  end if;
exception when duplicate_object then
  -- table already in the publication — fine.
  null;
end $$;
