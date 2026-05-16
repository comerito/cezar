-- Workspace-level switch for the runner's auto-comment behaviour.
--
-- When on, `core.runAction` posts a short Cezar-branded summary comment on
-- the target issue/PR after a successful run — unless the action itself
-- already called the `comment` effect (no double-comment). Off disables the
-- behaviour entirely. Default-on matches the legacy plugin set's behaviour
-- where every action left a clarifying comment explaining what it did.

alter table workspaces
  add column action_auto_comment boolean not null default true;

comment on column workspaces.action_auto_comment is
  'When true (default), the action runner posts a Cezar-branded summary
   comment on the target after each action runs — skipped when the action
   already posted its own comment via the `comment` effect.';
