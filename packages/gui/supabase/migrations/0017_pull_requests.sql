-- Pull-request mirror table — the PR counterpart of the `issues` table.
--
-- An earlier `pull_requests` table existed under migration 0006 to feed the
-- legacy issue↔PR matching loop; it was dropped in 0011 along with the rest
-- of the legacy autofix-candidates path. We now resurrect it for a different
-- purpose: a first-class /prs page in the GUI (parallel to /issues) and a
-- prs-sync cron that mirrors `issue-sync`.
--
-- Differences vs the 0006 schema:
--   - adds `labels text[]`, `draft boolean`, `state` is open|closed (PRs
--     never carry GitHub's `merged` state on /pulls/list — the API surfaces
--     merged PRs as `state=closed` with a separate `merged_at`)
--   - drops `referenced_issues` — link-based matching is no longer used
--   - mirrors the `issues` table's RLS + touch-trigger pattern

create table pull_requests (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  number         integer not null,
  title          text not null,
  body           text not null default '',
  state          text not null,
  draft          boolean not null default false,
  labels         text[] not null default '{}',
  author         text not null,
  html_url       text not null,
  head_sha       text,
  head_ref       text,
  base_ref       text,
  -- Timestamps on the upstream PR (not the row). Stored so the UI can show
  -- "opened 3d ago" without a separate fetch.
  pr_created_at  timestamptz,
  pr_updated_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint pull_requests_workspace_number_unique unique (workspace_id, number)
);

create index pull_requests_workspace_state_idx on pull_requests(workspace_id, state);
create index pull_requests_workspace_draft_idx on pull_requests(workspace_id, draft);

alter table pull_requests enable row level security;

create policy "pull_requests_member_select" on pull_requests
  for select using (is_workspace_member(workspace_id));

create trigger pull_requests_touch before update on pull_requests
  for each row execute function touch_updated_at();
