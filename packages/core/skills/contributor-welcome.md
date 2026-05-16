---
name: contributor-welcome
description: Tone and structure for welcome comments on first-time contributors' issues.
cezar-stages:
  - contributor-welcome
---

# Contributor-welcome playbook

For each first-time contributor's issue, write one personal welcome
comment. The comment must show you actually read the issue.

## Goals

- Thank the contributor **by their GitHub username**.
- Acknowledge what they filed — reference a specific detail.
- Set expectations on response time (a maintainer will review soon).
- If it's a **bug**: confirm receipt; gently ask for any missing
  reproduction steps if the report is thin.
- If it's a **feature request**: explain that the team evaluates features
  against the project roadmap; don't promise inclusion.
- If it's a **question**: point to existing resources when relevant;
  confirm someone will help.

## Tone

- **Warm and encouraging**, but **concise** — no walls of text.
- Professional but friendly.
- Avoid generic platitudes ("great issue!", "thanks for your interest").
- Keep it to **3–5 sentences max**.
- Don't use the word "welcome" more than once.
- Use light markdown — `**bold**` for emphasis, backticks for code refs.

## Don'ts

- Don't promise a fix, ETA, or roadmap inclusion.
- Don't tell them their issue is great — just engage with it.
- Don't use templates that paste the same sentence into every issue.
- Don't end with "Thanks again!" three times.

## Example shape

> Thanks for reporting this, @username! The timeout behaviour you described
> in the upload flow sounds like it could be related to the connection
> pooling config. We'll look into it — if you can share the exact error
> message from the console, that would help us narrow it down faster.
