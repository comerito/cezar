-- Issue-driven autofix loop (Phase 0).
-- Extends the CI-failure loop with an issue-driven counterpart: pull open
-- bug-labeled issues + open PRs on a schedule, then (in Phase 1) decide
-- which bugs lack a fix-in-flight and dispatch autofix for them.
--
-- Phase 0 only wires the schema + a per-workspace mode toggle. The cron
-- worker populates pull_requests and seeds issue_autofix_candidates for
-- new bug-labeled issues; Phase 1 adds the match/dispatch crons.

-- ─── Per-workspace mode ────────────────────────────────────────────────
create type issue_autofix_mode as enum ('off', 'notify', 'autonomous');

alter table workspaces
  add column issue_autofix_mode issue_autofix_mode not null default 'off';

-- ─── pull_requests (mirror of open PRs, for link-based matching) ───────
create table pull_requests (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  number              integer not null,
  title               text not null,
  body                text not null default '',
  state               text not null,
  author              text not null,
  html_url            text not null,
  head_sha            text,
  head_ref            text,
  base_ref            text,
  referenced_issues   integer[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint pull_requests_workspace_number_unique unique (workspace_id, number)
);

create index pull_requests_workspace_state_idx on pull_requests(workspace_id, state);
create index pull_requests_referenced_issues_idx on pull_requests using gin (referenced_issues);

-- ─── issue_autofix_candidates ──────────────────────────────────────────
-- One row per bug-labeled issue the loop considers.
-- Status values:
--   pending_match  — newly seen, awaiting PR-match cron
--   matched_to_pr  — an open PR already references this issue
--   unmatched      — no PR found, eligible for autofix dispatch
--   notified       — surfaced to user (notify mode), awaiting one-click
--   dispatched     — autofix flow created (links back via dispatched_flow_id)
--   resolved       — upstream issue closed, loop can stop
create type issue_autofix_candidate_status as enum (
  'pending_match',
  'matched_to_pr',
  'unmatched',
  'notified',
  'dispatched',
  'resolved'
);

create table issue_autofix_candidates (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  issue_number         integer not null,
  status               issue_autofix_candidate_status not null default 'pending_match',
  matched_pr_number    integer,
  matched_reason       text,
  dispatched_flow_id   uuid references flows(id) on delete set null,
  last_checked_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint issue_autofix_candidates_unique unique (workspace_id, issue_number)
);

create index issue_autofix_candidates_status_idx
  on issue_autofix_candidates(workspace_id, status);

-- ─── RLS ───────────────────────────────────────────────────────────────
alter table pull_requests enable row level security;
alter table issue_autofix_candidates enable row level security;

create policy "pull_requests_member_select" on pull_requests
  for select using (is_workspace_member(workspace_id));

create policy "iac_member_select" on issue_autofix_candidates
  for select using (is_workspace_member(workspace_id));

-- Actors can flip 'notified' → 'dispatched' via the one-click flow;
-- the cron uses the admin client and bypasses RLS.
create policy "iac_member_update" on issue_autofix_candidates
  for update using (is_workspace_member(workspace_id))
  with check (is_workspace_member(workspace_id));

-- ─── updated_at triggers ───────────────────────────────────────────────
create trigger pull_requests_touch before update on pull_requests
  for each row execute function touch_updated_at();

create trigger issue_autofix_candidates_touch before update on issue_autofix_candidates
  for each row execute function touch_updated_at();
