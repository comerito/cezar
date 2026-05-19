# Inbox & Acceptance Refactor — Design of Record

**Status:** in progress. Phase A is implemented in this PR; Phases B–D are
specified here and slated for follow-up PRs.

**Branch context:** continues `feat/ui-refactor`. Builds on the per-action
acceptance form (migration `0018_action_acceptance.sql`) that landed in the
prior commit.

---

## 1. What we're solving

Today the page labelled **Inbox** in the sidebar (`/dashboard`) is an action
launchpad — a grid of tiles for "run duplicates", "run priority", etc. It is
not an inbox in any meaningful sense: nothing waits for you, you have to pick
what to run, and a finding from `duplicates` (say) auto-applies the moment
the action runs. There is no second look, no per-action threshold, no human
gate except the autofix `confirm-fix-plan` step.

The new design (mocked at `/inbox-v2`) is a true inbox: a single chronological
list of things that need a human decision — PRs to review, paused workflow
gates, failed runs, and **AI findings sitting at medium confidence waiting
for accept/dismiss**. To make that last bucket real we need three things:

1. A place to store proposed-but-unapplied findings (`pending_decisions`).
2. A runner that knows when to apply vs. defer based on the action's
   `acceptance_mode` and `confidence_config` (migration `0018`).
3. An inbox UI backed by real data, plus accept/dismiss handlers that
   re-fire the captured effect on accept.

The acceptance form (model picker + auto/HITL toggle + thresholds + live
preview) already exists. This document specifies the rest of the loop and
the inbox refactor that surfaces it.

---

## 2. Non-goals

- **No global confidence framework for the entire codebase.** Only effects
  produced by actions whose `acceptance_mode='human-in-the-loop'` get
  routed through `pending_decisions`. Everything else preserves today's
  auto-apply behaviour.
- **No retroactive backfill.** Existing findings already in the `analysis`
  namespace stay where they are. Routing only applies to new runs.
- **No multi-reviewer / approvals quorum.** A pending decision needs one
  workspace admin to accept or dismiss it. We can add quorum later if a
  team requests it.
- **No model-graded confidence calibration.** We trust whatever number the
  model emits and let the user dial thresholds to taste. Calibration is a
  later concern.
- **The launchpad page is not deleted.** `/dashboard` stays reachable for
  one release as a fallback; the sidebar Inbox link moves to `/inbox` (the
  new page). Removing `/dashboard` is a follow-up cleanup.

---

## 3. Current state — what's already true (no action needed)

- **`actions.model` / `actions.acceptance_mode` / `actions.confidence_config`**
  are persisted (migration `0018`). The form on `/actions/[name]` writes
  them; the loader reads them. Default values preserve current behaviour:
  every existing row is `acceptance_mode='auto'` with `autoAcceptAbove=0`,
  i.e. "accept every finding regardless of confidence".
- **Inbox v2 mockup** is at `/inbox-v2` with mock data. The visual design
  is locked: header counts · filter chips · grouped decision cards · single
  rows for PR/paused/failed · bulk action bar · health footer. The
  acceptance-controls mockup is at `/inbox-v2/acceptance-demo`.
- **Workflow run state model is already correct.** `workflow_runs.status` is
  one of `queued|running|paused|succeeded|failed|cancelled`. The inbox can
  source paused and failed rows directly without schema changes.
- **PR table exists.** `pull_requests` (migration `0017`) tracks
  workspace-scoped PRs with `state` and `draft` columns. Inbox can list
  open non-draft PRs without schema changes.
- **Effect registry is the seam.** `packages/core/src/actions-v2/effects.ts`
  centralises every side-effect an action can perform (`label.add`, `comment`,
  `link-duplicate`, etc.). Each effect has a Zod schema. This is the natural
  place to capture vs. apply an effect.

---

## 4. Target architecture

```
                        ┌──────────────────────────────────────┐
                        │ Action runs (cron / webhook / manual)│
                        └──────────────┬───────────────────────┘
                                       │
                              effects + confidences
                                       │
                                       ▼
                ┌───────────────────────────────────────────────┐
                │   runner.ts  —  applyOrDefer(effect, conf)    │
                │   ┌─────────────────────────────────────┐     │
                │   │ acceptance_mode = auto              │     │
                │   │   ≥ autoAcceptAbove → apply         │     │
                │   │   <                 → drop          │     │
                │   ├─────────────────────────────────────┤     │
                │   │ acceptance_mode = human-in-the-loop │     │
                │   │   ≥ autoAcceptAbove → apply         │     │
                │   │   ≥ autoDenyBelow   → pending_decisions ──┼──┐
                │   │   <                 → drop          │     │  │
                │   └─────────────────────────────────────┘     │  │
                └───────────────────────────────────────────────┘  │
                                                                   ▼
                                            ┌──────────────────────────────┐
                                            │   pending_decisions table    │
                                            │   (workspace_id, action_id,  │
                                            │    issue_number, effect,     │
                                            │    args, confidence, status) │
                                            └──────────────┬───────────────┘
                                                           │
                                          ┌────────────────┴────────────────┐
                                          ▼                                 ▼
                              ┌───────────────────────┐         ┌──────────────────────┐
                              │  Inbox v2 (server)    │         │  Realtime channel    │
                              │  groups by issue,     │         │  (Supabase channels) │
                              │  exposes accept /     │         │  → inbox refresh     │
                              │  dismiss buttons      │         └──────────────────────┘
                              └────────┬──────────────┘
                                       │
                                       ▼
                          ┌─────────────────────────────┐
                          │ acceptDecision(id)           │
                          │   → executeEffect(effect,    │
                          │                   args)      │
                          │   → mark row accepted        │
                          │ dismissDecision(id, reason?) │
                          │   → mark row dismissed       │
                          └─────────────────────────────┘
```

---

## 5. Data model

### 5.1 `pending_decisions` (new, migration `0019`)

```sql
create table pending_decisions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  action_id       uuid not null references actions(id)    on delete cascade,
  workflow_run_id uuid          references workflow_runs(id) on delete set null,
  agent_run_id    uuid          references agent_runs(id)    on delete set null,

  -- What the finding is about (denormalised for inbox speed).
  issue_number    integer,
  pr_number       integer,
  target_kind     text not null check (target_kind in ('issue','pr')),
  target_title    text not null,

  -- The captured effect — name + args. Re-fires verbatim on accept.
  effect          text  not null,          -- e.g. 'label.add', 'comment'
  effect_args     jsonb not null,          -- effect-specific shape (validated by registry)
  summary         text  not null,          -- short human-readable description for the inbox row
  confidence      integer not null check (confidence between 0 and 100),

  -- Lifecycle
  status          text not null default 'pending'
                    check (status in ('pending','accepted','dismissed','expired')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id),
  decided_reason  text,                    -- optional free-text on dismiss
  apply_error     text,                    -- non-null if accept failed
  expires_at      timestamptz              -- optional auto-expiry
);

create index pending_decisions_workspace_status_idx
  on pending_decisions(workspace_id, status, created_at desc);

create index pending_decisions_workspace_issue_idx
  on pending_decisions(workspace_id, issue_number)
  where status = 'pending';

alter table pending_decisions enable row level security;
-- ... RLS: members read, admins write (mirrors actions table)
```

### 5.2 Why these columns

- **`effect` + `effect_args`** — single source of truth for "what to do on
  accept". No bespoke per-action handlers; we just re-run the captured
  effect through the existing `EFFECT_REGISTRY`. New effects automatically
  participate.
- **`summary`** — denormalised one-liner so the inbox renders without
  re-deriving from `effect_args`. Set by the runner when the row is
  created.
- **`confidence`** — integer 0..100 (not numeric). Cheap to sort/filter by.
- **`target_kind` + `target_title`** — denormalised so the inbox doesn't
  join to `issues` / `pull_requests` for every row. Title can drift but
  that's fine; the user clicks through for canonical state.
- **`apply_error`** — populated by `acceptDecision` if the effect raises.
  Keeps the row visible with the error so the user can re-try or dismiss.
- **`expires_at`** — not enforced yet; reserved for a future "auto-dismiss
  pending decisions older than N days" cron.

### 5.3 What does NOT change

- `actions` table — already has `acceptance_mode` + `confidence_config`
  (migration `0018`).
- `workflow_runs` / `agent_runs` / `agent_run_events` — unchanged.
- `analysis` namespace inside the file-store (CLI) — unchanged. The CLI
  doesn't have an inbox; it keeps auto-applying everything.

---

## 6. Confidence convention — how the runner gets a number

Today, an action's output is a list of `EffectCall`s with no confidence
attached. To route effects we need a per-effect number.

### 6.1 Schema extension

Add an optional `confidence` to `EffectCall`:

```ts
// packages/core/src/actions-v2/effects.ts
export interface EffectCall {
  effect: EffectName;
  args: unknown;
  /** 0..100 self-reported by the model. Optional; defaults to 100 (i.e.
   *  "apply always") so existing actions don't change behaviour. */
  confidence?: number;
}
```

### 6.2 How the model emits confidence

- **Declared mode** (`action.effects` is non-null): include `confidence` as
  an optional field in the per-effect output schema. The action's
  `output_schema` JSON gains:
  ```json
  { "type": "object",
    "properties": {
      "effect": { "type": "string" },
      "args":   { "type": "object" },
      "confidence": { "type": "integer", "minimum": 0, "maximum": 100 }
    },
    "required": ["effect", "args"]
  }
  ```
- **Tool-use mode** (`action.effects` is null): the model emits effects as
  Anthropic tool calls. Confidence is harder to thread through tool args
  without polluting every effect schema. **Workaround:** each tool gets a
  hidden `_confidence` parameter that the runner strips before executing.
  See §11 open questions — this may evolve.

### 6.3 Default when confidence is absent

`confidence ?? 100`. Treats unannotated effects as "fully confident", which
means HITL routing has no effect on existing actions until their prompts
are updated. Zero behavioural change at rollout.

### 6.4 Prompt updates (Phase C)

Update each built-in action's system prompt to include a one-liner like:

> When emitting effects, include a `confidence` integer 0..100 reflecting
> how certain you are this effect should fire. Use 90+ only when the
> evidence is unambiguous (exact text match, identical stack trace).

Done per-action as we decide which actions benefit from HITL routing —
`duplicates`, `priority`, `bug-detector`, `auto-label` first. `comment`,
`assign`, `close` likely never need it.

---

## 7. Runner integration

### 7.1 Where the branch lives

Single chokepoint: `packages/core/src/actions-v2/runner.ts`. Both
declared-mode and tool-use-mode funnel through one helper:

```ts
async function applyOrDefer(
  effect: EffectName,
  args: unknown,
  confidence: number,
  action: ActionDef,        // carries acceptance_mode + confidence_config
  ctx: EffectContext,
  deferSink: DeferSink,      // see 7.2
): Promise<{ outcome: 'applied' | 'deferred' | 'dropped'; summary: string }> {
  const mode = action.acceptanceMode ?? 'auto';
  const cfg = action.confidenceConfig ?? { autoAcceptAbove: 0 };
  const acceptAbove = cfg.autoAcceptAbove;
  const denyBelow = 'autoDenyBelow' in cfg ? cfg.autoDenyBelow : 0;

  if (confidence >= acceptAbove) {
    const summary = await executeEffect(effect, args, ctx);
    return { outcome: 'applied', summary };
  }
  if (mode === 'human-in-the-loop' && confidence >= denyBelow) {
    await deferSink({ effect, args, confidence, summary: '' });
    return { outcome: 'deferred', summary: `deferred to inbox (conf ${confidence})` };
  }
  return { outcome: 'dropped', summary: `dropped (conf ${confidence} < threshold)` };
}
```

### 7.2 `DeferSink` — write to pending_decisions

The runner doesn't know about Supabase. We pass in a `deferSink` function
from the dispatch layer (`packages/gui/src/lib/execute-workflow-job.ts`)
that performs the insert:

```ts
const deferSink: DeferSink = async ({ effect, args, confidence, summary }) => {
  await supabase.from('pending_decisions').insert({
    workspace_id: workspaceId,
    action_id: action.id,
    workflow_run_id: workflowRunId,
    agent_run_id: agentRunId,
    issue_number, pr_number, target_kind, target_title,
    effect, effect_args: args, summary, confidence,
  });
};
```

The CLI passes a no-op `deferSink` (always returns `dropped`) which means
the CLI keeps auto-applying-or-dropping with no inbox concept. That
matches CLI semantics.

### 7.3 Effect ordering preserved

Effects fire in the order the model produced them. When some are deferred,
the runner records `{ outcome, summary }` for each so the cockpit's
run-event log shows "applied label.add", "deferred comment (75% to inbox)",
etc. — no information loss.

---

## 8. Acceptance handlers

### 8.1 `acceptDecision(id)`

```ts
'use server';
export async function acceptDecision(id: string): Promise<Result> {
  const auth = await requireAdminWorkspace();
  if ('error' in auth) return { ok: false, error: auth.error };

  const row = await loadPending(id);
  if (!row || row.status !== 'pending') return { ok: false, error: 'not pending' };

  const ctx = await buildEffectContextForRow(row);
  try {
    const summary = await executeEffect(row.effect, row.effect_args, ctx);
    await markAccepted(id, auth.user.id, summary);
    revalidatePath('/inbox');
    return { ok: true };
  } catch (err) {
    await markApplyError(id, err.message);
    return { ok: false, error: err.message };
  }
}
```

### 8.2 `dismissDecision(id, reason?)`

```ts
'use server';
export async function dismissDecision(id: string, reason?: string): Promise<Result> {
  // ...
  await supabase.from('pending_decisions').update({
    status: 'dismissed', decided_at: now(), decided_by: user.id, decided_reason: reason ?? null
  }).eq('id', id);
  revalidatePath('/inbox');
}
```

### 8.3 Bulk variants

`acceptDecisions(ids[])` and `dismissDecisions(ids[])` — same logic in a
loop, single revalidatePath at the end. Required by the bulk action bar
in the mockup.

### 8.4 Failure semantics

Accept errors leave the row at status `pending` with `apply_error` set, so
the inbox can render a "Retry · Dismiss" affordance for that row. We do
not auto-retry — applying an effect can have side-effects (GitHub label
already set, comment already posted) and a blind retry could double-post.

### 8.5 Replay safety

Effects in the registry are not idempotent in the strict sense (commenting
twice posts twice). But:
- `label.add` checks the existing label set before adding (already today).
- `link-duplicate` checks if the relation exists.
- `comment` always posts — accept handlers must mark the row accepted
  before the comment fires so a double-click doesn't double-post. Use the
  Postgres "update where status='pending' returning id" pattern as a
  cheap mutex.

---

## 9. Inbox v2 page — what changes

### 9.1 Data sources (server-side fetch in `page.tsx`)

```ts
const [pending, openPrs, pausedRuns, failedRuns] = await Promise.all([
  supabase.from('pending_decisions')
    .select('id, action_id, issue_number, pr_number, target_kind, target_title, effect, effect_args, summary, confidence, created_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(100),
  supabase.from('pull_requests')
    .select('id, number, title, author, html_url, pr_created_at')
    .eq('workspace_id', workspaceId)
    .eq('state', 'open')
    .eq('draft', false)
    .order('pr_updated_at', { ascending: false })
    .limit(20),
  supabase.from('workflow_runs')
    .select('id, workflow, issue_number, pr_number, current_step_id, started_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'paused')
    .order('started_at', { ascending: false })
    .limit(20),
  supabase.from('workflow_runs')
    .select('id, workflow, issue_number, pr_number, reason, finished_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'failed')
    .gte('finished_at', new Date(Date.now() - 24*60*60*1000).toISOString())
    .order('finished_at', { ascending: false })
    .limit(20),
]);
```

### 9.2 Client-side grouping

`pending_decisions` rows group by `issue_number` (or `pr_number`) into the
decision cards from the mockup. Filter chips (Skill / Confidence / Type)
operate on the in-memory list — no server round-trip per filter change.

### 9.3 Realtime

Two Supabase channels, both filtered by `workspace_id`:

- `pending_decisions:INSERT,UPDATE,DELETE`
- `workflow_runs:INSERT,UPDATE` (status changes drive paused/failed bands)

When a relevant event fires, the client either patches the in-memory state
or triggers `router.refresh()` if the change is too big. Start with refresh
(simpler, ~100ms); upgrade to patching if perceptible lag appears.

### 9.4 Server actions wired from the view

The mockup's per-row `Accept` / `Dismiss` / bulk bar buttons call
`acceptDecision(id)` / `dismissDecision(id)` / their bulk variants
directly. No fetch boilerplate — `'use server'` action functions are
imported and invoked.

### 9.5 What we keep from the mockup

Everything: header counts, filter chips, decision cards with skill tags &
confidence pills, single-row cards for PR/paused/failed, bulk action bar
with `⌘A` shortcut, health footer. The mockup *is* the spec for the
layout — this PR only swaps mock data for real data.

---

## 10. Sidebar & route changes

### 10.1 Promote `/inbox-v2` → `/inbox`

Rename the directory `packages/gui/src/app/inbox-v2/` → `inbox/`. Update
the demo route to `inbox/acceptance-demo` or move it under `actions/`
since it's really an action-configuration preview.

### 10.2 Sidebar

Single line change in `packages/gui/src/components/sidebar.tsx`:

```diff
- { href: '/dashboard', label: 'Inbox', icon: <InboxIcon … /> },
+ { href: '/inbox',     label: 'Inbox', icon: <InboxIcon … /> },
```

### 10.3 `/dashboard` lifecycle

Three options, in order of preference:

1. **Retire it.** Replace `packages/gui/src/app/dashboard/page.tsx` with a
   server redirect to `/inbox`. Simplest; preserves any external links.
2. **Repurpose as a Dashboard.** Keep the repo-stats line + agent-runs
   card + a slim launchpad. Rename in sidebar from "Inbox" to "Dashboard".
   More work; only worth it if the launchpad still has a user.
3. **Delete the directory.** Cleanest in code but breaks any bookmark.

Recommend (1) as the rollout default — flip to (3) one release later.

---

## 11. Migrations & rollout

### 11.1 Order

1. `0018_action_acceptance.sql` — **already merged** in prior commit.
2. `0019_pending_decisions.sql` — this PR.
3. (later) Per-action prompt updates to start emitting confidence.

All three are additive. No data backfill required. Rollback = drop the
new table (`0019`) and the new columns on `actions` (`0018`); no data
loss because the runner ignores both until the rollout step below.

### 11.2 Behavioural rollout — opt in per action

The runner's `applyOrDefer` reads `action.acceptance_mode`. Default is
`auto`. **No behavior changes** until a workspace admin explicitly toggles
an action to `human-in-the-loop` on its detail page.

Recommended sequence:
1. Ship the table + runner hook + inbox refactor (this and the next PR).
2. Update **one** action's prompt to emit confidence — `duplicates` is
   the highest-value, clearest-UX candidate.
3. Toggle that one action to HITL with thresholds (e.g.
   `autoDenyBelow=60`, `autoAcceptAbove=92`).
4. Watch the inbox for a week. Tune thresholds. Iterate.
5. Generalize: extend prompts on `priority`, `bug-detector`, `auto-label`.

### 11.3 Reversibility

Toggling an action back to `auto` instantly removes its findings from the
inbox-routed path (new runs apply or drop). Existing `pending_decisions`
rows remain visible — the user accepts or dismisses them and the bucket
drains naturally.

---

## 12. Phased PR plan

Concrete cut-lines so each PR is reviewable.

### Phase A — **this PR**
- [x] Migration `0019_pending_decisions.sql`
- [x] Server actions `acceptDecision` / `dismissDecision` (single + bulk)
- [x] Inbox v2 page wired to real `pending_decisions` + `pull_requests` +
      `workflow_runs` data. Sidebar updated to point at `/inbox`.
- [x] Minimal runner hook in `actions-v2/runner.ts` — reads
      `acceptance_mode` + `confidence_config`, defers when applicable.
      Inert until model output starts including confidences.
- [ ] No prompt updates yet. No realtime yet (uses `revalidatePath`).

**End state:** A workspace admin can switch an action to HITL with
`autoAcceptAbove=101` (everything queues — manual-review mode) and exercise
the full loop on real data, even without prompt updates.

### Phase B — realtime + filters
- Supabase channel subscriptions for live updates.
- Per-finding "snooze" (sets `expires_at`).
- Filter chips operate on dynamic skill/action names (not the hardcoded
  enum used in the mock).

### Phase C — prompt updates
- Add `confidence` emission to `duplicates`, `priority`, `bug-detector`,
  `auto-label`. Each is a tiny prompt diff + an output-schema field.
- Validation: simulate against historical issues, check the distribution
  of self-reported confidences looks reasonable.

### Phase D — `/dashboard` retirement
- Replace `dashboard/page.tsx` with redirect to `/inbox`.
- Move `acceptance-demo` out from under `/inbox-v2`.
- Update any internal links / bookmarks.

---

## 13. Open questions / future-work

1. **Tool-use confidence threading.** §6.2 proposes `_confidence` as a
   hidden tool parameter. We may want a separate "confidence channel" via
   a dedicated `_confidence_report` tool the model calls between effects.
   Defer until Phase C — concrete prompt experiments will tell us which
   feels more natural to the model.

2. **Confidence calibration.** Self-reported confidences are notoriously
   uncalibrated (models cluster around 85–95). Consider a per-action
   calibration step that maps raw confidence to a normalized one based on
   accept/dismiss outcomes. Out of scope for now.

3. **Expiry policy.** `expires_at` is reserved but no cron drains it.
   Defer until users complain about stale decisions.

4. **Audit log on accept/dismiss.** Currently captured via
   `decided_by` / `decided_at`. A richer event log (who, when, with what
   note) could feed an Activity tab. Out of scope.

5. **Per-effect override of action thresholds.** A `comment` effect from
   the same action might warrant a lower bar than a `link-duplicate`. The
   `confidence_config` JSONB shape is flexible enough to grow into
   `{ "byEffect": { "comment": { ... }, "link-duplicate": { ... } } }`
   without a migration. Add when requested.

6. **Cockpit linkage.** Each `pending_decisions` row carries
   `workflow_run_id` / `agent_run_id`. The inbox row should link out to
   `/cockpit/[runId]` so the user can see the full run that produced the
   finding. Trivial UI add in Phase A or B.
