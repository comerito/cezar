---
name: auto-triage-playbook
description: First-pass triage playbook applied once per new issue or PR (and to old ones with no triage record).
cezar-stages:
  - auto-triage
---

# Auto-triage playbook

This is the **first pass** that runs once on every new issue or PR (and on
any old item that hasn't been triaged yet). Other specialised actions
still apply downstream based on their `(target, triggers)` filters — this
playbook is the entry point, not the only pass.

## Goals

1. Classify the item enough to **route it** — bug, feature, question, or
   other.
2. Apply a small set of **safe, reversible** effects: labels and (where
   warranted) a priority tag.
3. **Don't** close, assign, or comment in this pass unless the signal is
   overwhelming. Leave deeper decisions for specialised actions.

## Order of operations

1. Read title, body, and existing labels.
2. Classify category (`bug` / `feature` / `question` / `other`) using the
   `bug-classification` skill.
3. If `bug` and the report clearly describes a critical defect
   (data loss, security, production-down, crash with stack trace), add
   `priority/critical` via `set-priority`. Otherwise leave priority for
   the dedicated priority pass.
4. Add the matching type label (`bug` / `enhancement` / `question` /
   `documentation`) via `label.add` if the repo has those labels.
5. If the body is suspiciously empty / spammy / off-topic, add `invalid`
   and stop — don't run downstream actions.
6. Otherwise stop. Do **not** comment on the issue from this pass.

## Effects you may call

- `label.add` — type or status labels only.
- `set-priority` — only for clear critical defects.

## Effects you must NOT call here

- `comment` — let specialised actions like `contributor-welcome` or
  `missing-info` post.
- `close` — this is a triage pass, not a moderation pass.
- `link-duplicate` — that's the dedupe pass's job.
- `assign` — humans assign.

## When in doubt

Do less. The cost of a missed signal is small (downstream actions can
still flag it); the cost of a noisy mis-triage is high.
