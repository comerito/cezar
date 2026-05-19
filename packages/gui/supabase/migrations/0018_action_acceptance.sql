-- Adds per-action model selection and acceptance routing.
--
--   model           — which LLM the action runs on (e.g. claude-sonnet-4-6)
--   acceptance_mode — 'auto' (agent decides 100% by single cutoff)
--                   | 'human-in-the-loop' (medium-confidence findings queue
--                                          to the Inbox for human review)
--   confidence_config — JSONB with the threshold(s) used by the runner:
--                       auto mode:           { "autoAcceptAbove": number }
--                       human-in-the-loop:   { "autoDenyBelow": number,
--                                              "autoAcceptAbove": number }
--
-- Defaults preserve current behaviour: every existing row backfills to
-- auto mode with autoAcceptAbove=0, i.e. accept every finding regardless of
-- confidence — matching how actions already write to `analysis` today. The
-- runner does not consume these columns yet; this migration is the form-side
-- wiring. When the runner is taught to read them, low-confidence findings
-- will start being routed to a `pending_decisions` table (separate change).

alter table actions
  add column model             text   not null default 'claude-sonnet-4-6',
  add column acceptance_mode   text   not null default 'auto'
    check (acceptance_mode in ('auto', 'human-in-the-loop')),
  add column confidence_config jsonb  not null default '{"autoAcceptAbove": 0}'::jsonb;

comment on column actions.model is
  'LLM model id this action runs on (e.g. claude-opus-4-7, claude-sonnet-4-6,
   claude-haiku-4-5). Per-action override of any workspace default.';

comment on column actions.acceptance_mode is
  'How findings produced by this action are accepted. auto = agent decides
   100% by a single confidence cutoff. human-in-the-loop = medium-confidence
   findings queue to the Inbox for review.';

comment on column actions.confidence_config is
  'Threshold(s) interpreted by the runner. auto mode shape:
   {"autoAcceptAbove": number}. human-in-the-loop shape:
   {"autoDenyBelow": number, "autoAcceptAbove": number}. Values are 0..100.';
