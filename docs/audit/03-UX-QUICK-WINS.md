# UX quick wins — orthogonal to strategy

These five fixes are cheap, isolated, and improve UX regardless of which strategic direction (A, B, or C) is chosen. Treat as a backlog of polish work that can run in parallel with Phase 0.

---

## 1. Hub becomes a queue, not a menu

**Problem:** Today's hub forces the user to pick an action, *then* see findings. The mental model is backwards — maintainers want "what needs my attention?", not "which classifier should I run?"

**Fix:** First screen of `cezar` (no args) is a unified queue:
```
5 issues need your decision

  #142  duplicate of #87 (94% confidence)            [a]ccept [s]kip
  #189  missing repro steps                          [d]raft comment
  #203  stale 60+ days, no maintainer response       [c]lose [k]eep
  #211  bug-fix PR #214 looks ready                  [m]ark done
  #220  proposed labels: bug, ui                     [a]pply
```

Action menu becomes secondary (`cezar actions` or a sub-menu).

**File:** `packages/cli/src/ui/hub.ts`
**LOC:** ~150 net new, but enables deletion of repeated per-action review boilerplate over time.

---

## 2. One comment per issue per run

**Problem:** When `auto-label`, `priority`, and `missing-info` all fire on the same issue, the user gets three separate Cezar comments. Noisy.

**Fix:** Aggregate all findings for an issue into a single audit comment per run. Edit the comment on re-run instead of appending. Format:

```markdown
🤖 **Cezar review** — 2026-05-06

**Findings:**
- Likely missing repro steps. [Suggested questions ↓]
- Suggested labels: `bug`, `ui`
- Priority: `high` (mentioned in 3 other issues)

<details>
<summary>Suggested missing-info comment</summary>

> Hey @author, thanks for the report! Could you share...
</details>

<sub>Reply with `cezar-disagree` to dismiss findings, or just edit the issue.</sub>
```

**Files:** `packages/core/src/services/audit.ts:17` (replace `withAuditFooter` / `postAuditComment` with a `consolidateAuditComment(issueNumber, findings[])` that uses GitHub's PATCH on existing Cezar comments).

---

## 3. Consolidate the six cron endpoints

**Problem:** `issue-sync`, `issue-match`, `issue-fix`, `ci-watch`, `ci-attribute`, `ci-fix` are six independent Vercel cron handlers. No transactional guard. Stalled rows possible. Hard to debug.

**Fix:** One cron tick (`*/1 * * * *`), one handler that runs the state machine: `pending_match → matched_to_pr | unmatched → notified | dispatched → resolved`. Plus explicit retry/backoff per row (`last_attempted_at`, `attempt_count`, `last_error`).

**Files:**
- `packages/gui/src/app/api/cron/*` — collapse the six into `/api/cron/tick/route.ts`.
- `packages/gui/supabase/migrations/` — add `last_attempted_at`, `attempt_count`, `last_error` columns to `issue_autofix_candidates` and `flows`.
- `vercel.json` — single cron entry.

**Bonus:** add a "Stalled candidates" panel to the dashboard that surfaces rows with `attempt_count > 3`.

---

## 4. Preflight modal before autofix dispatch

**Problem:** In `notify` mode, clicking "Activate" on the Issues page blind-dispatches to the cockpit. User has no chance to review repo path, base branch, token budget, or pick dry-run.

**Fix:** Modal between click and dispatch:

```
Run autofix on issue #142?

  Repo:           comerito/cezar @ feat/extract-core
  Base branch:    main
  Token budget:   250k per attempt (max 3 attempts)
  Mode:           [ ] Dry run    [x] Apply (open PR)

  Skill:          autofix-root-cause (built-in)
                  [Browse skills...]

  [Cancel]                                    [Run]
```

**Files:**
- `packages/gui/src/app/issues/components/ActivateButton.tsx`
- New: `packages/gui/src/app/issues/components/PreflightModal.tsx`

---

## 5. Drop silent no-op flags

**Problem:** `cezar run release-notes --state=open --format=json` accepts both flags but neither is honored. CI users get misleading output.

**Fix:** Per-action flag whitelist. Unknown / unsupported flags → fail loudly with a list of supported flags for that action.

**File:** `packages/cli/src/index.ts` — extend Commander setup so each action declares its supported flags, and `run` validates against that.

**Bonus:** print the resolved config + flags at the top of every action run (one line) so users see what's actually being applied.

---

## Also worth doing (smaller items)

- **Validate token before fetch.** `packages/cli/src/ui/setup.ts:50` checks for env var presence but doesn't ping `/user`. A bad token fails 30s into the fetch instead of immediately.
- **Show "0 changes" idle state** in `AutofixLoopCard` instead of empty card when mode is `off`.
- **Link to the analysis from the comment.** Every Cezar comment should link to a hosted analysis page (or local file path in CLI mode) so authors can dispute specific findings.
- **Cap interactive decision tree to 4 options max.** `duplicates` currently has 7 options per item (close-dup, close-orig, label, store, skip, browser, stop). Collapse to 4.

---

## What this list deliberately omits

- **Full reposition to skills** — covered in `00-AUDIT-REPORT.md` Option B and `01-PHASE-0-PLAN.md`.
- **Action deletion** — covered in `02-DELETION-CANDIDATES.md`.
- **GUI redesign** — out of scope; the cockpit and dashboard need real design work, not a quick win.
