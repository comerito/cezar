---
name: missing-info-checklist
description: Per-issue-type checklist for what counts as enough info to investigate a bug.
cezar-stages:
  - missing-info
---

# Missing-info checklist

A bug report is "missing info" when a maintainer can't begin investigation
without asking for more. Be **context-aware** — the right checklist depends
on the issue type.

## Per-area checklists

- **Database** — schema details, the failing query, database version, exact
  error message.
- **UI** — browser + version, OS, screen size or device, steps to reproduce,
  screenshot or screen recording for visual bugs.
- **API** — endpoint, request body, response body, HTTP status code, time
  of the request when relevant.
- **CLI** — exact command run, OS + shell, tool version (`--version`),
  terminal output / exit code.
- **Crash / error** — full error message, **complete** stack trace, steps
  to reproduce.

## Universal floor

Every bug needs:
- **Steps to reproduce.**
- **Expected vs. actual behaviour.**

If those are present, lean toward "not missing" even if some area-specific
detail is absent — a maintainer can ask follow-up questions naturally.

## Check the comments first

If the missing info was already provided in comments (someone followed up
with a stack trace, the reporter clarified their OS, etc.) → mark
`hasMissingInfo: false`. Don't re-ask.

## Suggested-comment style

When asking for missing info:
- Polite, specific, **3–5 bullets max**.
- Tailor each ask to this specific issue — no copy-paste templates.
- Lead with thanks for reporting; close with why you're asking
  ("to help us diagnose and fix this faster").
