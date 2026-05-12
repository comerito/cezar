# Option B — Full UI Design (Skill Runner)

**Mental model:** Cezar is "your `.claude/skills/*.md` running autonomously on your GitHub issues." A skill is the unit of customization. An issue is the unit of work. A run is the unit of execution.

This document specifies every page in the GUI for Option B, including layout, states, data sources, and primary actions. Companion to `00-AUDIT-REPORT.md` and `01-PHASE-0-PLAN.md`.

---

## Information architecture

```
Sidebar
 ├─ Inbox       ← default landing — pending decisions across all skills
 ├─ Issues      ← full issue table with skill outcomes per row
 ├─ Skills      ← repo + built-in skills, edit/enable/disable
 ├─ Runs        ← history of skill executions
 ├─ Activity    ← unified audit log (comments, labels, PRs Cezar made)
 └─ Settings
     ├─ General
     ├─ Loop
     ├─ Members
     └─ Tokens
```

**Top bar:** workspace switcher · search · notifications · user menu.

**Primary page = Inbox.** Everything else is reachable from it.

---

## Page 1 — Inbox

The queue. Replaces today's "action grid" mental model with an issue-first view.

### When user lands here
- Default route after login
- Shows pending decisions: every issue × skill that produced a finding the user hasn't acknowledged yet

### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Inbox                                          12 pending decisions │
│ Filter: [All skills ▾] [Any confidence ▾] [Last 30 days ▾] [Reset]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ #142  Login crashes on Safari iOS                            bug    │
│   ├─ duplicates       likely dup of #87 (94%)        [accept] [✗]   │
│   └─ missing-info     no repro steps                 [draft]  [✗]   │
│                                                                     │
│ #189  TypeError on null user                                 bug    │
│   └─ autofix-bug      root cause found, ready to fix [run dry] [✗]  │
│                                                                     │
│ #203  Stale 60+ days, no maintainer response                        │
│   └─ stale-cleanup    suggest close                  [close] [keep] │
│                                                                     │
│ #211  PR #214 merged, may be done                                   │
│   └─ done-detector    likely resolved by #214        [close] [✗]    │
│                                                                     │
│ ─── more ───                                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### Per-row anatomy
- **Issue header line:** #number · title · primary label
- **Finding rows (one per skill):** skill name · finding summary · primary action button · dismiss
- **Hover:** show full finding text in a tooltip

### Bulk operations
Top-right "Bulk" button reveals checkboxes. Then:
- Select all from one skill → "Accept all (12)"
- Select multiple → "Dismiss" / "Snooze 7 days"

### Empty state
> 🎉 Nothing waiting on you. Skills will queue findings here when they detect something. **[Run skills now]**

### Error state per row
> ⚠️ This skill failed on #142. **[See run]**  · row stays visible until acknowledged

### Data sources
- Supabase: `issues` joined with `issue_findings` (new table — see Skills section)
- Realtime: subscribe to `issue_findings` inserts to update count badge

### Keyboard
- `j/k` move selection · `enter` open issue detail · `a` accept default action · `x` dismiss · `/` focus filter

---

## Page 2 — Issues

The full issue table. "Show me all issues regardless of whether they need my attention."

### When user lands here
- Switch from inbox when wanting to browse rather than triage
- Direct navigation from `?issue=142` deep links

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Issues                                              143 open · 45 closed │
│ State: [Open ▾]  Label: [Any ▾]  Skill: [Any ▾]  Search: [____] [↺ Sync] │
├──────────────────────────────────────────────────────────────────────┤
│ #    Title                       Labels    Skill outcomes      Updated │
├──────────────────────────────────────────────────────────────────────┤
│ #142 Login crashes on Safari iOS bug,ui    🔍dup ❓info          2d   │
│ #189 TypeError on null user      bug       🤖fix-ready           4h   │
│ #203 Old issue                   stale     🧹close-suggested    60d   │
│ #205 Welcome screen flash        ui                              1w   │
│ ...                                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Skill outcome chips
Each issue row shows chips for skills that produced a finding. Color-coded:
- 🟢 green: action taken (label applied, comment posted, PR opened)
- 🟡 yellow: pending decision
- ⚪ grey: ran with no finding
- 🔴 red: skill failed

Click chip → jump to that skill's finding inside issue detail.

### Toolbar actions
- **[↺ Sync]** — manual incremental sync from GitHub
- **[Run all skills]** — re-run skills against current filter selection
- **[Export CSV]** — for analytics use

### Empty state
> No issues yet. **[Connect a repo]** or **[Sync now]** if you've already configured one.

### Data sources
- `issues` table, joined with aggregated `issue_findings` per skill
- Filter pushed down to SQL via Postgres views

---

## Page 3 — Issue detail

Full drill-down for a single issue. Shows GitHub data plus every skill's analysis.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ ← Back     #142  Login crashes on Safari iOS                 [Open ↗]│
│ Open · @author · opened 5d ago · labels: bug, ui                     │
├──────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐ ┌──────────────────────────────┐ │
│ │ Body                            │ │ Skill findings               │ │
│ │                                 │ │                              │ │
│ │ When I open the app on Safari   │ │ 🔍 duplicates                │ │
│ │ iOS 17, the login screen...     │ │   Likely dup of #87 (94%)    │ │
│ │                                 │ │   "Both describe Safari..."  │ │
│ │ [4 comments]                    │ │   [Accept]  [Dismiss]        │ │
│ │ ─                               │ │                              │ │
│ │ Comment by @user2:              │ │ ❓ missing-info              │ │
│ │ Same on Firefox iOS too.        │ │   No reproduction steps      │ │
│ │ ─                               │ │   [Draft comment]  [Skip]    │ │
│ │                                 │ │                              │ │
│ │ Comment by 🤖 Cezar:            │ │ 🤖 autofix-bug               │ │
│ │ Cezar review — 2026-05-04       │ │   Status: idle               │ │
│ │   • Likely dup of #87           │ │   [Run dry]  [Run apply]     │ │
│ │   • Missing repro steps         │ │                              │ │
│ │                                 │ │ ─ Other skills (no finding)─ │ │
│ │                                 │ │   priority · auto-label ·    │ │
│ │                                 │ │   stale · welcome            │ │
│ └─────────────────────────────────┘ └──────────────────────────────┘ │
│                                                                      │
│ Run history                                                          │
│  • 2026-05-04 16:22  duplicates       success   [view run ↗]         │
│  • 2026-05-04 16:22  missing-info     success   [view run ↗]         │
│  • 2026-05-04 16:21  autofix-bug      analyze   [view run ↗]         │
└──────────────────────────────────────────────────────────────────────┘
```

### Two-column body
- **Left:** issue body + comment thread (rendered Markdown). Cezar comments highlighted with the bot icon.
- **Right:** one card per skill that has produced any finding for this issue. Skills with no finding listed compactly at the bottom.

### Skill finding card states
- **No finding:** "Skill ran, nothing to flag." (greyed)
- **Pending decision:** primary action button + dismiss
- **Acted:** green checkmark + summary ("Posted comment · 2d ago") + [undo if reversible]
- **Failed:** red banner + "[See run]"

### Below the fold
- **Run history:** chronological log of every skill execution against this issue, with link to the run's cockpit page

### Actions
- **[Open ↗]** — open on GitHub
- **[Re-run skill]** — per-card three-dot menu

### Data sources
- `issues` row + `issue_findings` for this issue + `flows` runs scoped to this issue

---

## Page 4 — Skills (the new central surface)

The customization surface. Lists every skill — built-in, repo-supplied, and workspace overrides — with editing affordances.

### When user lands here
- Click "Skills" in sidebar
- After onboarding, prompted to "review your skills"

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Skills                                              [Sync from repo] │
│                                                     [+ New override] │
│ Source: [All ▾]  Status: [All ▾]  Mode: [All ▾]                      │
├──────────────────────────────────────────────────────────────────────┤
│ Name              Source     Mode    Trigger      Status   Last run  │
├──────────────────────────────────────────────────────────────────────┤
│ duplicates        built-in   inline  on-sync       enabled 12m ago   │
│ missing-info      override*  inline  on-sync       enabled 12m ago   │
│ autofix-bug       repo       framed  label:bug     enabled 4h ago    │
│ welcome           repo       framed  new-author    enabled 1d ago    │
│ stale-cleanup     built-in   inline  cron:weekly   enabled 5d ago    │
│ priority          built-in   inline  on-sync       disabled —        │
│                                                                      │
│ * = repo override of a built-in skill                                │
└──────────────────────────────────────────────────────────────────────┘
```

### Row states
- **built-in** (grey): shipped with Cezar, no user file
- **override** (blue, asterisked): user has a `.cezar/skills/<name>.md` that overrides a built-in
- **repo** (green): user-only skill, no built-in equivalent

### Per-row actions (right of row, on hover)
- **Edit** → opens skill editor (Page 5)
- **Disable / Enable** → toggle (writes to workspace overrides table)
- **Run now** → manual trigger against all open issues
- **View runs** → filtered Runs page
- **⋯ menu:** Duplicate · Reset to built-in · Delete override

### Toolbar
- **[Sync from repo]** — pulls latest `.cezar/skills/*.md` from default branch via GitHub API. Shows diff if files changed.
- **[+ New override]** — opens editor pre-filled from a built-in skill

### Empty state
> No custom skills yet. Cezar ships with **6 built-in skills** that work out of the box. **[Add a skill file to your repo]** at `.cezar/skills/` to customize behavior.

### Data sources
- Built-in skills bundled in `@cezar/core` (file system at module load)
- Repo skills: fetched via GitHub API (`.cezar/skills/*.md` from default branch), cached in `workspace_skills` table
- Workspace overrides: `workspace_skill_overrides` table (enabled flag, last-run, etc.)

---

## Page 5 — Skill editor

View and edit one skill's frontmatter and body. Preview against a sample issue.

### Layout

```
┌───────────────────────────────────────────────────────────────────────┐
│ ← Skills · missing-info                                               │
│ Source: override of built-in · file: .cezar/skills/missing-info.md    │
│                                                                       │
│ ┌─────────────────────┐ ┌───────────────────────────────────────────┐ │
│ │ Frontmatter         │ │ # Skill instructions                      │ │
│ │                     │ │                                           │ │
│ │ name                │ │ When an issue body is missing reproduction│ │
│ │ [missing-info]      │ │ steps, draft a comment that asks for them │ │
│ │                     │ │ in our project's voice...                 │ │
│ │ mode                │ │                                           │ │
│ │ ( ) inline          │ │ Always:                                   │ │
│ │ (•) framed          │ │ - link to CONTRIBUTING.md                 │ │
│ │                     │ │ - use British English                     │ │
│ │ trigger             │ │ - never use "guys" — say "folks"          │ │
│ │ ( ) on-sync         │ │                                           │ │
│ │ ( ) label: [_____]  │ │ ...                                       │ │
│ │ (•) cron: [weekly▾] │ │                                           │ │
│ │                     │ │ (Markdown editor with syntax highlight)   │ │
│ │ output              │ │                                           │ │
│ │ [x] post comment    │ │                                           │ │
│ │ [ ] apply labels    │ │                                           │ │
│ │ [ ] open PR         │ │                                           │ │
│ │                     │ │                                           │ │
│ │ confirm: maintainer │ │                                           │ │
│ │ budget: 8k tokens   │ │                                           │ │
│ └─────────────────────┘ └───────────────────────────────────────────┘ │
│                                                                       │
│ ┌─────────────────────────────────────────────────────────────────┐   │
│ │ Test against issue [#142 ▾]    [Run preview]                    │   │
│ │                                                                 │   │
│ │ Resolved system prompt:                                         │   │
│ │ ┌───────────────────────────────────────────────────────────┐   │   │
│ │ │ <Cezar default missing-info system prompt>                │   │   │
│ │ │                                                           │   │   │
│ │ │ ## Repo-specific guidance                                 │   │   │
│ │ │ <skill body inserted here>                                │   │   │
│ │ └───────────────────────────────────────────────────────────┘   │   │
│ │                                                                 │   │
│ │ Output (after dry-run):                                         │   │
│ │ > Hey @author, thanks for the report! Could you share which    │   │
│ │ > version of Safari iOS you're seeing this on, and any console │   │
│ │ > errors? Our [CONTRIBUTING guide](...) has tips on collecting │   │
│ │ > those.                                                       │   │
│ └─────────────────────────────────────────────────────────────────┘   │
│                                                                       │
│ [Discard]  [Save as override]  [Save & enable]                        │
└───────────────────────────────────────────────────────────────────────┘
```

### Editor regions
- **Frontmatter form (left):** structured form for known fields. Free-form YAML toggle for advanced users.
- **Body editor (right):** Monaco with Markdown grammar. Inline lint warnings (e.g., "skill body should not exceed 4k tokens for inline mode").
- **Preview panel (bottom):** pick an issue, click "Run preview", see the resolved prompt and dry-run output.

### Save flow
- **Save as override** writes to `workspace_skill_overrides` (DB-only, doesn't touch the repo).
- **Push to repo** secondary action commits the file to `.cezar/skills/<name>.md` via GitHub API + opens a PR.

### Reset
- "Reset to built-in" wipes the override after a confirm.

### States
- **Unsaved changes:** sticky banner "You have unsaved changes" with [Discard] [Save].
- **Override out of sync with repo:** banner "Repo file is newer — [view diff] [accept repo] [keep override]".

---

## Page 6 — Runs

History of every skill execution. Successor to today's `Flows` page.

### Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ Runs                                                                 │
│ Skill: [All ▾]  Status: [All ▾]  Issue: [_____]  Date: [Last 7d ▾]   │
├──────────────────────────────────────────────────────────────────────┤
│ Started   Skill           Issue   Status      Outcome     Duration   │
├──────────────────────────────────────────────────────────────────────┤
│ 16:22     duplicates      —       succeeded   12 findings 4s         │
│ 16:22     missing-info    #142    succeeded   comment-drafted 8s     │
│ 16:21     autofix-bug     #189    running     analyze       1m 12s   │
│ 14:05     stale-cleanup   #203    succeeded   close-posted  6s       │
│ 12:01     autofix-bug     #178    failed      review-blocked 4m      │
└──────────────────────────────────────────────────────────────────────┘
```

### Status values
`queued · running · succeeded · failed · cancelled · skipped`

### Click row → cockpit (Page 7)

### Filters
Skill, status, issue (free-text), date range. Save filter as a "view".

### Bulk actions
Cancel queued · Retry failed (last 24h)

### Data sources
- `flows` table (rename in schema or keep — UI label is "Runs")
- For inline skills, even though they don't have a state machine, surface them here as zero-duration rows for unified history

---

## Page 7 — Run cockpit

Live (or replay) view of a single skill execution.

### Layout for **framed** skills (multi-stage, e.g., autofix-bug)

```
┌───────────────────────────────────────────────────────────────────────┐
│ ← Runs · autofix-bug · #189                running   1m 12s          │
│                                                                       │
│ ┌─────────────────┐ ┌─────────────────────────────┐ ┌───────────────┐ │
│ │ Stages          │ │ Agent activity              │ │ Run info      │ │
│ │                 │ │                             │ │               │ │
│ │ ✓ analyze    8s │ │ [16:21:08] tool:Read        │ │ Skill         │ │
│ │ ▸ fix    running│ │   src/auth/login.ts         │ │ autofix-bug   │ │
│ │ ○ review        │ │                             │ │ v3 (override) │ │
│ │ ○ commit        │ │ [16:21:14] text             │ │               │ │
│ │ ○ open-pr       │ │   "Found null check missing │ │ Issue #189    │ │
│ │                 │ │    in handleAuth callback"  │ │               │ │
│ │                 │ │                             │ │ Branch        │ │
│ │ Attempt 1 of 3  │ │ [16:22:01] tool:Edit        │ │ cezar/189-... │ │
│ │                 │ │   src/auth/login.ts (+3 -1) │ │               │ │
│ │                 │ │                             │ │ Token budget  │ │
│ │                 │ │ [16:22:04] tool:Bash        │ │ ████░░░░ 92k  │ │
│ │                 │ │   npm test                  │ │ / 250k        │ │
│ │                 │ │                             │ │               │ │
│ │                 │ │ ▸ live...                   │ │ Confirm gate  │ │
│ │                 │ │                             │ │ ✓ root cause  │ │
│ │                 │ │ [Verbose ▾]                 │ │   accepted    │ │
│ └─────────────────┘ └─────────────────────────────┘ │               │ │
│                                                     │ Artifacts     │ │
│ [Pause]  [Cancel]  [Open worktree ↗]                │  • diff       │ │
│                                                     │  • test log   │ │
│                                                     └───────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

### Layout for **inline** skills (single LLM call, e.g., duplicates)

Single-column transcript. No stages, no token budget, just:

```
┌─────────────────────────────────────────────────────────────────────┐
│ ← Runs · duplicates · sync-time                  succeeded · 4s     │
│                                                                     │
│ Input batch                                                         │
│   200 issue digests · 12k tokens                                    │
│                                                                     │
│ System prompt (resolved)                          [show] [diff vs default] │
│                                                                     │
│ Output                                                              │
│   12 duplicate groups detected                                      │
│   ┌───────────────────────────────────────────────────────────┐    │
│   │ Group 1: #142, #87                                         │    │
│   │ Group 2: ...                                               │    │
│   └───────────────────────────────────────────────────────────┘    │
│                                                                     │
│ [Re-run]  [View findings in inbox]                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### Live updates
Realtime subscription to `flow_events` for the run; events render in the agent activity feed.

### Actions
- **Pause** (framed, autofix only) — soft stop after current stage
- **Cancel** — hard stop with cleanup
- **Open worktree ↗** — launches local editor at the cloned path (when running locally)
- **Re-run** — same skill, same issue, fresh attempt

### Verbose toggle
Default view: tool calls, text outputs, stage transitions. Verbose: every Agent SDK event including thinking blocks, tool inputs/outputs in full.

### Failed run UI
- Banner with failure reason
- Link to view review verdict (for autofix)
- "Retry from stage X" button

---

## Page 8 — Activity

Unified audit log of everything Cezar did externally — comments posted, labels applied, PRs opened, issues closed.

### Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Activity                                                            │
│ Type: [All ▾]  Skill: [All ▾]  Date: [Last 30 days ▾]               │
├─────────────────────────────────────────────────────────────────────┤
│ 16:22  💬 commented on #142   missing-info     [view comment ↗]     │
│ 16:21  🏷️ labeled #142 dup    duplicates       [view issue ↗]       │
│ 14:05  🚪 closed #203          stale-cleanup    [view issue ↗]      │
│ 09:14  🔀 opened PR #214       autofix-bug      [view PR ↗]         │
│ ...                                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this exists
Maintainers (and their teammates) need a "what did the bot do today?" feed for trust. Today's CLI dumps audits to stdout; the GUI needs a durable stream.

### Click row → expand showing exact diff/comment/payload posted to GitHub.

### Data sources
- `audit_log` table (new — append-only). Every GitHub mutation writes a row with `{action, skill_id, issue_number, payload, github_response_url}`.

---

## Page 9 — Settings

Tabbed page. Workspace-scoped configuration.

### Tab: General
- Workspace name, slug
- Repo (`owner/repo`) · disabled if installed via GitHub App
- Sync schedule (cron string + presets)
- Include closed issues (toggle)
- Default LLM model
- Token budget defaults (per-skill override available in skill editor)

### Tab: Loop
The autofix loop config that today is buried in the DB.

```
┌─────────────────────────────────────────────────────┐
│ Issue-driven autofix loop                           │
│                                                     │
│ Mode                                                │
│   ( ) Off       — don't dispatch                    │
│   (•) Notify    — show one-click activation         │
│   ( ) Autonomous — run automatically                │
│                                                     │
│ Trigger                                             │
│   Label filter: [bug ▾] [+]                         │
│   Min confidence: [70% ▾]                           │
│                                                     │
│ Limits                                              │
│   Max concurrent runs:    [3]                       │
│   Max retries per issue:  [3]                       │
│   Token budget per attempt: [250k]                  │
│                                                     │
│ Branch policy                                       │
│   Base branch: [main ▾]                             │
│   Branch prefix: [cezar/]                           │
│   PR opens as: [draft ▾]                            │
│                                                     │
│ [Save]                                              │
└─────────────────────────────────────────────────────┘
```

### Tab: Members
- Table: email · GitHub login · role (admin/actor/viewer)
- Invite by email · revoke · role change (admin only)

### Tab: Tokens
- GitHub token status (per-user, scoped to workspace)
- Anthropic API key (per-workspace)
- Test connection buttons

### Tab: Webhooks (future)
Stubbed for now; will receive GitHub webhook events directly instead of cron polling.

---

## Page 10 — Onboarding

First-time user flow after sign-up.

### Step 1 — Connect GitHub
> Cezar runs against your GitHub repos. Install the GitHub App to get started.
> **[Install GitHub App]**

### Step 2 — Pick a repo
List of repos the app has access to. Click one → creates workspace.

### Step 3 — First sync
Live progress: "Fetching issues 23/143..." → "Generating digests 23/143..."

### Step 4 — Seed skills
> Cezar ships with 6 built-in skills. We can drop example skill files in `.cezar/skills/` of your repo so you can customize them anytime.
> **[Commit example skills to a PR]**  ·  **[Skip — use built-ins]**

If user picks "Commit", Cezar opens a PR with example `.md` files. Otherwise built-ins run as-is.

### Step 5 — Land on Inbox
With a "Welcome" toast and a tutorial overlay highlighting:
- Inbox (the queue)
- Skills page (where to customize)
- Settings → Loop (autofix mode)

---

## Cross-cutting concerns

### Notifications
- **In-app toasts:** for actions completed in the current session
- **Notification center (bell icon, top bar):** for things that happened while user was away — failed runs, autofix PRs that need review, mode changes
- **Email digests (opt-in):** daily summary of inbox items

### Loading states
- **Page skeletons** for first paint (rows of grey blocks)
- **Inline spinners** for actions (button shows spinner, disables)
- **Optimistic UI** for accept/dismiss in inbox — row disappears immediately, rolls back on error

### Error states
- **Top-of-page banner** for workspace-wide errors (sync failed, token invalid)
- **Per-row badge** for skill failures
- **Empty-with-error** distinction: never show "no items" when there's an underlying fetch error

### Mobile
Out of scope for v1. Read-only inbox view at minimum. Editing skills requires desktop.

### Accessibility
- All actions keyboard-reachable
- Color is never the sole signal (use icons + text for skill outcome chips)
- ARIA labels on icon-only buttons

---

## State machine summary (referenced by Run cockpit)

### Inline skill (e.g., duplicates, auto-label)
```
queued → running → succeeded
                 → failed
```

### Framed skill (e.g., autofix-bug)
```
queued
  → analyze         (claude session 1)
    → confirm-gate? (notify mode only)
      → fix         (claude session 2)
        → commit
          → review  (claude session 3)
            → succeeded   (open PR)
            → retry       (back to analyze, attempt+1)
            → failed      (max attempts hit)
```

Every state transition writes a `flow_events` row consumed by the cockpit feed.

---

## Schema additions for Option B

| Table | Purpose | Notable columns |
|---|---|---|
| `workspace_skills` | Cached repo `.cezar/skills/*.md` | `workspace_id, name, source_path, body, frontmatter (jsonb), synced_at` |
| `workspace_skill_overrides` | Per-workspace overrides + enabled flag | `workspace_id, skill_name, enabled, override_body, override_frontmatter` |
| `issue_findings` | Output of any skill run on an issue (replaces today's per-action JSON namespace) | `id, workspace_id, issue_number, skill_name, finding (jsonb), status (pending/accepted/dismissed/applied), created_at, decided_at` |
| `audit_log` | Activity feed source | `id, workspace_id, skill_name, issue_number, action_type, payload (jsonb), github_url, created_at` |

`flows` and `flow_events` tables stay for framed skills.

---

## What we delete from today's UI

- The "actions grid" on the dashboard — replaced by Inbox.
- Today's `/dashboard` page — its repo-stats card moves to Inbox header; everything else dissolves.
- Per-action settings spread across pages — consolidated into the Skills page.
- The "Run full pipeline" button — replaced by per-skill "Run now" plus auto-runs on sync.

---

## Suggested build order

1. **Skills page (read-only)** — list built-in + repo skills; no editing yet
2. **Inbox page** — the queue; needs `issue_findings` table and aggregation
3. **Issue detail page** — pulls from `issue_findings` and `flows`
4. **Skill editor** — most complex page; build last in v1
5. **Runs cockpit** — adapt today's flow cockpit to handle inline skills (single-column variant)
6. **Settings → Loop** — move DB-only fields to UI
7. **Activity** — wire up `audit_log` writes from existing GitHub-mutation paths
8. **Onboarding** — polish last

Each step is independently shippable; ship behind a feature flag (`gui.option_b`) until the full set is ready.
