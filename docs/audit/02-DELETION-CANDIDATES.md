# Deletion / hide candidates — six speculative actions

These six actions ship in the registry but produce no GitHub side-effect that a maintainer could not get faster by reading the issue. They inflate the hub menu, the test surface, and the cognitive load on first-time users. Recommend hiding them behind an `experimental` flag in Phase 0 and removing them entirely once a 1-month metric (analytics or self-reported) confirms low usage.

---

## 1. `release-notes`

**Path:** `packages/core/src/actions/release-notes/`
**Runner LOC:** 133
**GitHub mutations:** none — generates a Markdown blob that's printed to stdout.

**Why drop:** the GitHub Releases API supports auto-generated release notes natively. Cezar's version is divorced from milestones, tags, and the actual release flow. The output goes nowhere by default. Maintainers who want this use `gh release create --generate-notes` or release-please.

**If kept:** it should write to `CHANGELOG.md` or open a draft GitHub Release. Currently does neither.

---

## 2. `milestone-planner`

**Path:** `packages/core/src/actions/milestone-planner/`
**Runner LOC:** 89 (smallest of all actions)
**GitHub mutations:** none — groups issues into hypothetical milestones, prints them.

**Why drop:** the action stops one keystroke short of being useful — it doesn't apply the milestones. Maintainers planning a release don't need a tool that suggests groupings; they need one that creates GitHub milestones and assigns issues. Half-done feature.

**If kept:** wire it to GitHub's Milestones API and let the user accept-and-apply.

---

## 3. `issue-check`

**Path:** `packages/core/src/actions/issue-check/`
**Runner LOC:** 79
**GitHub mutations:** none — it's a "check before reporting" tool.

**Why drop:** **wrong audience.** Cezar is positioned for repo *maintainers*. This action helps issue *reporters* search for similar issues before filing one. That's the job of GitHub's "similar issues" feature, the issue template, or a saved search — not a maintainer's CLI tool. Even if useful, this should be a separate utility.

**If kept:** ship as a standalone CLI (`cezar-author` or similar) targeting a different persona.

---

## 4. `needs-response`

**Path:** `packages/core/src/actions/needs-response/`
**Runner LOC:** 122
**GitHub mutations:** none — lists "issues awaiting maintainer response."

**Why drop:** every maintainer can already get this view via `is:open is:issue -commenter:@me sort:updated-desc` in GitHub search. The action adds no analysis (it's a filter, not Claude-driven). Costs sync overhead (org members) for what is essentially a saved query.

**If kept:** turn it into an *escalation* — auto-label `needs-maintainer-response`, ping in a configured channel. Mere display has no value.

---

## 5. `categorize`

**Path:** `packages/core/src/actions/categorize/`
**Runner LOC:** 114
**GitHub mutations:** comment footer only.

**Why drop:** **direct overlap with `bug-detector`**. Both classify issues. `categorize` uses categories `framework / domain / integration`; `bug-detector` uses `bug / feature / question / other`. Neither enforces labels. Two actions doing the same job in different vocabularies is a UX bug, not a feature.

**Resolution:** delete `categorize`. Promote `bug-detector` to apply labels (rename → `auto-classify`).

---

## 6. `bug-detector`

**Path:** `packages/core/src/actions/bug-detector/`
**Runner LOC:** 118
**GitHub mutations:** none — display only.

**Why drop (in current form):** see above — overlaps with `categorize` and doesn't apply labels. As a *display-only* action it's dead weight.

**If kept:** merge with `categorize`, rename to `auto-classify`, and have it apply labels (`type:bug`, `type:feature`, `type:question`). That makes one useful action out of two redundant ones.

---

## Borderline (do NOT drop in Phase 0, but watch)

These three are not on the deletion list, but show signs of low ROI. Revisit after metrics:

- **`claim-detector`** — useful but niche. Most repos don't have contributors claiming issues in comments.
- **`priority`** — comment-footer-only output is weak; should also apply labels (`priority:high` etc.).
- **`quality`** — overlaps philosophically with `missing-info`. Could potentially fold into it.

---

## Implementation sketch (Phase 0, Step 5)

```ts
// packages/cli/src/ui/hub.ts
const EXPERIMENTAL_ACTIONS = new Set([
  'release-notes',
  'milestone-planner',
  'issue-check',
  'needs-response',
  'categorize',
  'bug-detector',
]);

const visibleActions = config.experimental
  ? allActions
  : allActions.filter(a => !EXPERIMENTAL_ACTIONS.has(a.id));
```

```ts
// packages/core/src/config/config.model.ts
experimental: z.boolean().default(false),
```

Update `README.md` to move the six to an "Experimental" subsection with a note: *"These actions are under review for removal. Set `experimental: true` in `.issuemanagerrc.json` to enable them."*

---

## Removal timeline (post-Phase 0)

| Week | Action |
|---|---|
| Week 1 (Phase 0) | Hide behind `experimental` flag |
| Week 4 | Check usage metrics / user feedback |
| Week 5 | Delete code if no advocates emerged |
| Week 5 | Update spec, README, tests |

Total code freed: ~600 runner LOC + ~900 interactive LOC + their prompts and stores ≈ **~2000 LOC removed** = simpler product surface, faster onboarding, less maintenance.
