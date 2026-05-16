-- Action overrides — let a user-authored action carry the same `name` as a
-- built-in action and take precedence at runtime.
--
-- Until now `actions` had a `unique (workspace_id, name)` constraint, which
-- meant overriding a built-in required renaming. That broke the "same
-- conceptual action, just with my tweaks" mental model that already works
-- for skill_overrides (migration 0012). We relax to `(workspace_id, name,
-- kind)` so a `built-in` row and its `user` companion can coexist; the
-- runtime loader prefers the user row whenever both exist.
--
-- Adds a nullable `replaces_built_in` text column carrying the name of the
-- built-in this user action overrides — kept distinct from `name` so the UI
-- can tell at a glance whether a user action is freshly-authored or a copy
-- of a built-in (and so we can show a "revert to built-in" affordance).

alter table actions
  add column replaces_built_in text;

alter table actions
  drop constraint actions_workspace_id_name_key;

alter table actions
  add constraint actions_workspace_id_name_kind_key
  unique (workspace_id, name, kind);

create index actions_workspace_replaces_idx
  on actions(workspace_id, replaces_built_in)
  where replaces_built_in is not null;

comment on column actions.replaces_built_in is
  'When the row is a user override of a built-in action, this is the built-in
   name. Null for fresh user actions and for the built-ins themselves.';
