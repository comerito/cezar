-- Seed the default Action set into every workspace.
--
-- Each action is the converted form of a legacy TypeScript action plugin:
-- a system prompt (the operative instruction) + skill_refs (markdown
-- playbooks shipped with @cezar/core under packages/core/skills/). All
-- seeded rows are `kind='built-in'` — RLS on the actions table prevents
-- users from editing them in place. To customise, users override by copy
-- (the override pattern from migration 0012 applies to actions too once
-- the GUI cockpit lands).
--
-- The function below is idempotent — it ON CONFLICT DO NOTHING per (
-- workspace_id, name), so re-running it is safe. New workspaces should
-- call this from their post-creation server action; existing workspaces
-- are backfilled at the bottom of this file.
--
-- Skill markdown lives in packages/core/skills/ and is loaded at runtime
-- by discoverSkills — this migration does NOT embed the prompt bodies,
-- only the system_prompt + skill_refs reference.

create or replace function seed_default_actions(p_workspace_id uuid)
returns void
language plpgsql
as $$
declare
  v_auto_triage_id uuid;
begin
  -- ─── 1. Auto-triage — the "main" first-pass action ──────────────────
  insert into actions (
    workspace_id, name, kind, description, system_prompt, skill_refs,
    target, triggers, effects, output_schema, enabled
  ) values (
    p_workspace_id,
    'auto-triage',
    'built-in',
    'First-pass triage applied once per new issue or PR. Adds type labels and (for clear critical defects) a priority. Defers commenting, closing, and assigning to specialised actions.',
    'You are running the first triage pass on a freshly-opened item. Read the playbook in your reference skills and apply ONLY the effects it authorises. Be conservative — when a signal is weak, do less. Call label.add for type labels and set-priority for clear critical defects. Do not comment, close, link as duplicate, or assign in this pass.',
    '["auto-triage-playbook", "bug-classification"]'::jsonb,
    'issue',
    '["on-issue-opened", "on-issue-reopened", "manual"]'::jsonb,
    null,  -- null effects → tool-use mode; agent picks from label.add / set-priority
    null,
    true
  )
  on conflict (workspace_id, name) do nothing
  returning id into v_auto_triage_id;

  -- If the row already existed, fetch its id so we can point the workspace
  -- pointer at it below.
  if v_auto_triage_id is null then
    select id into v_auto_triage_id
    from actions
    where workspace_id = p_workspace_id and name = 'auto-triage';
  end if;

  update workspaces
    set auto_triage_action_id = v_auto_triage_id
    where id = p_workspace_id
      and auto_triage_action_id is null;

  -- ─── 2. Bug detection ───────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'bug-detector',
    'built-in',
    'Classify an issue as bug / feature / question / other using a confidence-calibrated rubric.',
    'Classify the issue using the bug-classification playbook in your reference skills. Output a structured classification: a category, a confidence between 0 and 1, and one short sentence citing the signal you relied on. When confident this is a bug, add the bug label.',
    '["bug-classification"]'::jsonb,
    'issue',
    '["on-issue-opened", "on-issue-edited", "manual"]'::jsonb,
    '["label.add"]'::jsonb,
    '{"type":"object","required":["category","confidence","reason"],"properties":{"category":{"type":"string","enum":["bug","feature","question","other"]},"confidence":{"type":"number","minimum":0,"maximum":1},"reason":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 3. Priority ────────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'priority',
    'built-in',
    'Assign an impact-and-urgency priority level (critical / high / medium / low) with cited signals.',
    'Pick exactly one priority level per the priority-rubric playbook in your reference skills. Cite specific evidence from the issue body — not generic claims. Apply the priority via set-priority.',
    '["priority-rubric"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    '["set-priority"]'::jsonb,
    '{"type":"object","required":["priority","reason","signals"],"properties":{"priority":{"type":"string","enum":["critical","high","medium","low"]},"reason":{"type":"string"},"signals":{"type":"array","items":{"type":"string"}}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 4. Duplicates ──────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'duplicates',
    'built-in',
    'Detect duplicate issues against an open-issue knowledge base; minimum confidence 0.80.',
    'Apply the dedupe-heuristics playbook in your reference skills. Only flag matches at confidence ≥ 0.80. Use the link-duplicate effect to mark the duplicate; do NOT call close (a human reviewer decides).',
    '["dedupe-heuristics"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    null,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 5. Auto-label ──────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'auto-label',
    'built-in',
    'Apply repo-defined labels based on content. Never invents new labels.',
    'Apply the auto-labeling-rubric playbook in your reference skills. ONLY use labels from the repository''s existing label set passed in the context. Add labels via label.add; remove obviously wrong labels via label.remove.',
    '["auto-labeling-rubric"]'::jsonb,
    'issue',
    '["on-issue-opened", "on-issue-edited", "manual"]'::jsonb,
    null,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 6. Missing info ────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'missing-info',
    'built-in',
    'Detect bug reports missing critical info; post a tailored ask if so.',
    'Apply the missing-info-checklist playbook in your reference skills. Check comments first — if the missing info was already provided, set hasMissingInfo to false. For incomplete reports, post a polite tailored comment (3–5 bullets max) asking for exactly what is needed.',
    '["missing-info-checklist"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    '["comment", "label.add"]'::jsonb,
    '{"type":"object","required":["hasMissingInfo"],"properties":{"hasMissingInfo":{"type":"boolean"},"missingFields":{"type":"array","items":{"type":"string"}},"suggestedComment":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 7. Security ────────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'security',
    'built-in',
    'Flag issues with security implications, even when not explicitly labelled.',
    'Apply the security-signals playbook in your reference skills. Flag only at confidence ≥ 0.70. False positives are preferable to missing a vulnerability. Add a security label via label.add and consider posting a maintainer-only comment summarising the finding.',
    '["security-signals"]'::jsonb,
    'issue',
    '["on-issue-opened", "on-issue-edited", "manual"]'::jsonb,
    '["label.add", "comment"]'::jsonb,
    '{"type":"object","required":["isSecurityRelated","confidence"],"properties":{"isSecurityRelated":{"type":"boolean"},"confidence":{"type":"number","minimum":0,"maximum":1},"category":{"type":"string"},"severity":{"type":"string","enum":["critical","high","medium","low"]},"explanation":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 8. Quality ─────────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'quality',
    'built-in',
    'Identify low-quality submissions (spam, vague, test, wrong-language).',
    'Apply the quality-rubric playbook in your reference skills. Be conservative — when in doubt mark "ok". Apply the suggested label (if any) via label.add.',
    '["quality-rubric"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    '["label.add"]'::jsonb,
    '{"type":"object","required":["quality"],"properties":{"quality":{"type":"string","enum":["ok","spam","vague","test","wrong-language"]},"reason":{"type":"string"},"suggestedLabel":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 9. Good first issue ────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'good-first-issue',
    'built-in',
    'Surface issues suitable for newcomers; add the good-first-issue label.',
    'Apply the good-first-issue-signals playbook in your reference skills. Reject issues that need deep architectural understanding or substantial refactoring. When suitable, add the good-first-issue label via label.add.',
    '["good-first-issue-signals"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    '["label.add"]'::jsonb,
    '{"type":"object","required":["isGoodFirstIssue"],"properties":{"isGoodFirstIssue":{"type":"boolean"},"reason":{"type":"string"},"codeHint":{"type":"string"},"estimatedComplexity":{"type":"string","enum":["trivial","small","medium"]}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 10. Claim detector ─────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'claim-detector',
    'built-in',
    'Find issues where someone claimed to take it but went silent (>14 days).',
    'Apply the claim-signals playbook in your reference skills. Only flag claims older than 14 days with no follow-through and no PR reference. Post the polite nudge via comment.',
    '["claim-signals"]'::jsonb,
    'issue',
    '["on-cron", "manual"]'::jsonb,
    '["comment"]'::jsonb,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 11. Contributor welcome ────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'contributor-welcome',
    'built-in',
    'Personalised welcome comment for first-time contributors.',
    'Apply the contributor-welcome playbook in your reference skills. Reference a specific detail from the issue — no generic platitudes. 3–5 sentences max. Post via comment.',
    '["contributor-welcome"]'::jsonb,
    'issue',
    '["on-issue-opened"]'::jsonb,
    '["comment"]'::jsonb,
    '{"type":"object","required":["welcomeMessage"],"properties":{"welcomeMessage":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 12. Recurring questions ────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'recurring-questions',
    'built-in',
    'Detect open questions already answered in closed issues; suggest a redirect.',
    'Apply the recurring-question-patterns playbook in your reference skills. Reference closed issues by number — never invent answers. Post the suggested redirect via comment.',
    '["recurring-question-patterns"]'::jsonb,
    'issue',
    '["on-cron", "manual"]'::jsonb,
    '["comment"]'::jsonb,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 13. Categorise ─────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'categorize',
    'built-in',
    'Categorise issues as framework / domain / integration based on the area touched.',
    'Apply the categorization-rubric playbook in your reference skills. One category per issue. Add an area label via label.add when appropriate.',
    '["categorization-rubric"]'::jsonb,
    'issue',
    '["on-issue-opened", "manual"]'::jsonb,
    '["label.add"]'::jsonb,
    '{"type":"object","required":["category","reason"],"properties":{"category":{"type":"string","enum":["framework","domain","integration"]},"reason":{"type":"string"}}}'::jsonb,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 14. Done detector ──────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'done-detector',
    'built-in',
    'Find open issues silently resolved by merged PRs; suggest closing.',
    'Apply the done-signals playbook in your reference skills. Mark isDone only at confidence ≥ 0.70. Post a polite closing comment via comment and close via close when confident.',
    '["done-signals"]'::jsonb,
    'issue',
    '["on-cron", "manual"]'::jsonb,
    '["comment", "close"]'::jsonb,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;

  -- ─── 15. Stale ──────────────────────────────────────────────────────
  insert into actions (workspace_id, name, kind, description, system_prompt, skill_refs, target, triggers, effects, output_schema, enabled)
  values (
    p_workspace_id,
    'stale',
    'built-in',
    'Triage stale issues — close / label / keep-open per the stale-criteria rubric.',
    'Apply the stale-criteria playbook in your reference skills. Prefer label-stale over closing when unsure. For close-resolved / close-wontfix, post the draft comment and call close. For label-stale, post the comment and add a stale label via label.add.',
    '["stale-criteria"]'::jsonb,
    'issue',
    '["on-cron", "manual"]'::jsonb,
    '["comment", "close", "label.add"]'::jsonb,
    null,
    true
  )
  on conflict (workspace_id, name) do nothing;
end;
$$;

-- Backfill every existing workspace.
do $$
declare
  ws record;
begin
  for ws in select id from workspaces loop
    perform seed_default_actions(ws.id);
  end loop;
end;
$$;

comment on function seed_default_actions(uuid) is
  'Insert (or no-op) the default Action set into a workspace. Called once
   at workspace-create time from the server action layer; also invoked at
   the bottom of this migration to backfill existing workspaces.';
