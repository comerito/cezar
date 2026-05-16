---
name: good-first-issue-signals
description: Signals for issues suitable as a newcomer's first contribution.
cezar-stages:
  - good-first-issue
---

# Good-first-issue signals

A **good first issue** is one a new contributor can finish in under a day
with basic experience and no architectural understanding of the codebase.

## Suitable signals

- **Self-contained scope** — finishable without understanding the full
  architecture.
- **Clear acceptance criteria** — the expected outcome is unambiguous.
- **No architectural decisions needed** — the implementation approach is
  obvious from the issue or a quick code read.
- **Reasonable effort** — under one day for a newcomer with basic
  experience in the project's stack.
- **Well-documented area** — the affected code area is approachable, has
  examples nearby, and isn't fragile.

## Reject when

- Requires deep understanding of multiple interconnected systems.
- Involves complex concurrency, performance-critical code, or
  security-sensitive paths.
- Is vague or under-specified — newcomers will get stuck on definition.
- Requires significant refactoring or breaking changes.

## Effort estimate

When `isGoodFirstIssue: true`, include:
- `trivial` — under an hour.
- `small` — a few hours.
- `medium` — half a day.

If it would take a full day or more, it's not a good first issue.

## Code hint

A one-line pointer to where to start. Use the affected area or a known
neighbour file, e.g. `"Look at src/forms/ — validation utils already exist
for other fields."`
