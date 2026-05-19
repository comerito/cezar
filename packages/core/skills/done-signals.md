---
name: done-signals
description: Signals for spotting open issues that have been silently completed by a merged PR.
cezar-stages:
  - done-detector
---

# Done-detection signals

Goal: find open issues that have been **silently resolved** by one or more
merged pull requests, so they can be closed cleanly.

## Confidence calibration

- **0.90–1.00** — A merged PR's title or description **explicitly** fixes
  this issue. Examples: `"Fix #123"`, `"Resolve missing translations for
  #123"`, `"Closes #123"`.
- **0.70–0.89** — A merged PR is clearly related and **likely** resolves
  the issue based on the issue summary and PR title/diff.
- **Below 0.70** — The PR is tangentially related, or it's unclear whether
  it fully resolves the issue. Do not mark as done.

## Rules

- Set `isDone: true` only when confidence ≥ **0.70**.
- Set `isDone: false` if the PR is tangential or only partially addresses
  the issue — the maintainer can review and close manually.
- Consider **all** merged PRs referencing the issue; multiple PRs may
  together resolve it.

## Draft-comment shape

When `isDone: true`, draft a polite closing comment that **references the
resolving PR(s) by number**. Brief and grateful, no purple prose:

```
This issue appears to have been resolved by PR #281. Closing as completed.
```

When `isDone: false`, set the draft comment to an empty string.
