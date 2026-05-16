---
name: stale-criteria
description: Decision rubric for triaging stale issues — close, label, or keep open.
cezar-stages:
  - stale
---

# Stale-issue triage criteria

Stale issues are issues with no activity for a long time. For each, pick
**one** of four actions. When in doubt, prefer `label-stale` over closing.

## Decisions

- **close-resolved** — The issue was likely fixed by another issue/PR or is
  no longer reproducible. Draft a polite closing comment explaining why
  and citing the resolving issue/PR if known.
- **close-wontfix** — The issue is outdated, superseded, or no longer
  relevant. Draft a comment explaining the reasoning.
- **label-stale** — The issue **might** still be valid but needs author
  confirmation. Draft a comment asking if it's still relevant, noting it
  will be closed after a known stale-close window without activity.
- **keep-open** — The issue is clearly still relevant and unresolved. No
  comment needed.

## Guidelines by issue type

- **Bug** — Check if a similar closed issue suggests the bug was fixed. If
  it's a core-feature bug not clearly resolved, prefer `label-stale` over
  closing.
- **Question** — If answered in comments or in a closed issue, close as
  resolved.
- **Feature** — If superseded by a different implementation or a closed
  request, close as wontfix. If still valid, `label-stale`.
- **Docs / chore** — Usually safe to close as wontfix if no longer
  relevant.

## When to keep open

- Recent comments show active discussion.
- Someone is openly working on it (claim signals).
- The issue has a recent PR referencing it.
- Many reactions or comments → indicates ongoing user impact.

## Draft-comment style

- Polite, brief, and explain the reasoning.
- Reference related closed issues by number when relevant.
- For `keep-open`, set the draft comment to an empty string.
