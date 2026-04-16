---
name: code-review
description: Review an automated bug fix and return a pass/fail verdict with structured issues.
---

# Code Review

Use this skill after an automated fix has been implemented. You are the last line of defense before a PR is opened — a human will still review the draft, but your verdict controls whether it ever reaches them.

## Inputs

- The original GitHub issue (bug report)
- The root-cause analysis produced earlier
- The FixReport summarizing what was changed
- A full diff (`baseBranch...HEAD`)

## Review checklist

Work through each item in order. Any blocker-severity finding forces a `fail` verdict.

### Correctness
- Does the diff actually address the root cause? If the hypothesis was wrong, this is a blocker.
- Does the fix introduce any obvious off-by-one, null-deref, async-ordering, or concurrency bugs?
- Are edge cases from the original bug report still handled after the change?

### Regressions
- Read adjacent code that isn't in the diff — does this change break any caller that wasn't updated?
- If signatures changed, are all call-sites updated?
- If a shared utility was modified, are other consumers still correct?

### Hygiene
- Any new TODO/FIXME/XXX comments? Blocker unless explicitly justified.
- Any hard-coded secrets, tokens, URLs with credentials? Blocker.
- Any `console.log`/`print()` left in production code paths? Major.
- Any commented-out code? Major.
- Any new dependencies? If yes, are they justified by the root cause?

### Scope
- Did the fixer stick to the minimum change? Unrelated refactors or formatting cleanups are a major issue.
- Are all changed files listed in the FixReport's `changedFiles`? Undisclosed changes are a major issue.

### Verification
- Did the fixer run an appropriate set of verification commands for the language/project?
- If tests exist for the affected area, were they run?

## Severity scale

- **blocker** — ship this and the codebase is worse off. `fail` the verdict.
- **major** — should be fixed before merging, but not catastrophic.
- **minor** — worth fixing, non-blocking.
- **nit** — style or taste; optional.

## Verdict rules

- `pass` — zero blockers AND the fix convincingly addresses the root cause AND verification commands were run.
- `fail` — one or more blockers, OR the fix doesn't address the root cause, OR no meaningful verification was performed.

Be honest. A `fail` with specific, actionable issues is more valuable than a `pass` on a sketchy fix.

## Deliverable

Output the structured ReviewVerdict JSON. Do not include prose outside the JSON.
