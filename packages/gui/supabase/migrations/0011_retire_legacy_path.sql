-- Retire the legacy `flows`-backed autofix loop, replaced by the
-- `workflow_runs` / `agent_runs` / `agent_run_events` cockpit path that
-- ships in 0008–0010 and is now the only autofix code path.
--
-- Tables dropped here:
--   `flows`, `flow_events` — legacy run + event log (replaced by `workflow_runs`/`agent_run_events`).
--   `ci_failed_checks`, `ci_attributions`, `ci_fix_attempts` — legacy CI follow-up state (subsumed by `jobs.kind='ci-followup'` + the engine).
--   `issue_autofix_candidates` — legacy dashboard "issue autofix loop" cards (replaced by the cockpit + per-issue Fix button).
--   `pull_requests` — only populated by the legacy `issue-sync` candidate matcher; not read by the new path.
--
-- NO backfill. The cockpit's history starts at the cutover. Pre-cutover run
-- history (if you care to preserve it) should be exported separately before
-- applying this migration.
--
-- The legacy `workspaces.issue_autofix_mode` column is also retired — the
-- new path uses `workspaces.auto_triage_enabled` + `workspaces.autofix_enabled`
-- (added in 0007).

-- ── Drop legacy tables ─────────────────────────────────────────────────────
DROP TABLE IF EXISTS public.ci_fix_attempts CASCADE;
DROP TABLE IF EXISTS public.ci_attributions CASCADE;
DROP TABLE IF EXISTS public.ci_failed_checks CASCADE;
DROP TABLE IF EXISTS public.issue_autofix_candidates CASCADE;
DROP TABLE IF EXISTS public.flow_events CASCADE;
DROP TABLE IF EXISTS public.flows CASCADE;
DROP TABLE IF EXISTS public.pull_requests CASCADE;

-- ── Drop the retired workspace toggle ──────────────────────────────────────
ALTER TABLE public.workspaces
  DROP COLUMN IF EXISTS issue_autofix_mode;
