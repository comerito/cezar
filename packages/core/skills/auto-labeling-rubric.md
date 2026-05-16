---
name: auto-labeling-rubric
description: Rubric for applying repo-defined labels to issues from content.
cezar-stages:
  - auto-label
---

# Auto-labeling rubric

Only use labels from the **repository's existing label set**. Never invent
new labels. Each suggestion must use an exact label name (case, spacing,
slashes — all match).

## Label families

- **Type labels** — `bug`, `enhancement`, `documentation`, `question`, etc.
  At most one type label per issue (use the strongest signal).
- **Area / scope labels** — `area: auth`, `scope/api`, `pkg:gui`, etc.
  Multiple area labels are fine when an issue spans concerns.
- **Priority labels** — only assign `priority/critical` or `priority/high`
  when the issue describes data loss, security vulnerabilities, crashes, or
  production outages. Default to letting a dedicated priority pass handle
  priority labels.
- **Status / lifecycle labels** — `needs-info`, `duplicate`, `invalid`,
  `wontfix`, `good first issue`. Set these only when the matching condition
  is clearly met.

## Rules

- If the issue already has the right labels, return an empty suggestion
  list — don't churn.
- Only suggest labels that are **not already on the issue**.
- Each suggestion must exist verbatim in the available-labels list passed in.
- Prefer fewer, well-chosen labels over many marginal ones.

## Reason field

One short sentence explaining the suggestions, e.g.:

- `"Crash report in the OAuth flow — bug + area: auth"`
- `"Asks for a new export format — enhancement + area: export"`
