-- Agent-cockpit refactor — Phase 1.
-- Adds the GUI-editable workflow mapping + the cached repo skill catalog:
--   * workflow_bindings — per (workspace, repo, step) {skill, backend, model, extra_tools}.
--     A null/empty binding means "use the built-in default" — no row needed; the
--     core orchestrator (Phase 1a) reads these to augment a step's prompt and
--     pick a backend/model.
--   * repo_skills — the skill catalog discovered from `<repo>/.ai/skills/**/*.md`,
--     cached with the commit SHA it was read at. Metadata only (name, description,
--     suggestedStages, path) — not the full skill bodies.
--   * workspaces — three workspace-level workflow toggles
--     (auto_triage_enabled, autofix_enabled, separate_comment_per_step).
-- See docs/REFACTOR-PLAN-agent-cockpit.md §3.1, §3.7.

-- ─── workflow_bindings ──────────────────────────────────────────────────
create table workflow_bindings (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  -- null = applies to all repos in the workspace. Today a workspace has one
  -- repo so this is always null, but the column stays for the multi-repo future.
  repo         text,
  step_id      text not null,
  skill_name   text,
  backend      text check (backend in ('anthropic-api', 'claude-cli', 'codex-cli')),
  model        text,
  extra_tools  jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Unique per (workspace, repo-or-default, step). `coalesce(repo,'')` so the
-- "all repos" (null) binding collides with itself, not with a repo-scoped one.
create unique index workflow_bindings_unique
  on workflow_bindings (workspace_id, coalesce(repo, ''), step_id);
create index workflow_bindings_workspace_idx on workflow_bindings(workspace_id);

-- ─── repo_skills ────────────────────────────────────────────────────────
create table repo_skills (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  repo         text not null,
  commit_sha   text,
  -- Array of {name, description, suggestedStages, path}. Bodies are re-read
  -- from the clone on demand — only metadata is cached here.
  skills       jsonb not null default '[]'::jsonb,
  fetched_at   timestamptz not null default now(),
  primary key (workspace_id, repo)
);

-- ─── workspaces: workflow toggles ───────────────────────────────────────
alter table workspaces
  add column auto_triage_enabled        boolean not null default true,
  add column autofix_enabled            boolean not null default false,
  add column separate_comment_per_step  boolean not null default false;

-- ─── RLS ────────────────────────────────────────────────────────────────
alter table workflow_bindings enable row level security;
alter table repo_skills       enable row level security;

-- SELECT: any workspace member. INSERT/UPDATE/DELETE: workspace admins.
create policy "workflow_bindings_member_select" on workflow_bindings
  for select using (is_workspace_member(workspace_id));
create policy "workflow_bindings_admin_write" on workflow_bindings
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

create policy "repo_skills_member_select" on repo_skills
  for select using (is_workspace_member(workspace_id));
create policy "repo_skills_admin_write" on repo_skills
  for all using (is_workspace_admin(workspace_id)) with check (is_workspace_admin(workspace_id));

-- ─── updated_at trigger ─────────────────────────────────────────────────
-- Reuses the shared touch_updated_at() defined in 0001_init.sql.
create trigger workflow_bindings_touch before update on workflow_bindings
  for each row execute function touch_updated_at();
