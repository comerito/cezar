---
name: bug-classification
description: Playbook for classifying GitHub issues as bug / feature / question / other.
cezar-stages:
  - bug-detector
  - categorize
---

# Bug classification playbook

When an action references this skill, it gets the following categorisation
rules as context. The action's *system prompt* governs the invocation style
(batch vs. single, output schema, tone, side-effects); this playbook defines
**what counts** as each category and the signals to rely on.

## Categories

- **bug** — Something is broken, produces wrong output, crashes, or behaves
  differently from what is documented/expected. Bug reports usually include
  reproduction steps, actual vs expected behaviour, error messages, or stack
  traces.
- **feature** — A request for new functionality or an enhancement to existing
  functionality that is not currently broken.
- **question** — The reporter is asking how to use something, seeking
  clarification, or requesting support. No code defect is implied.
- **other** — Docs, chores, discussions, tracking issues, or anything that
  does not fit the three categories above.

## Confidence calibration

- `≥ 0.8` only when the issue text **clearly** matches the category
  (reproduction steps for bugs, explicit feature-request wording, explicit
  question, etc).
- `0.5 – 0.8` when the category is likely but the text is ambiguous.
- `< 0.5` when you're unsure — still pick the best-fit category but signal
  low confidence so a human reviewer can step in.

## Tie-breakers

- Prefer **other** over guessing when an issue is clearly not a bug / feature
  / question (e.g. a tracking meta-issue, a release checklist, a stale
  marker, a duplicate notice).
- A label such as `bug`, `enhancement`, or `question` is a signal but **not a
  shortcut** — read the body. Maintainers re-label often.
- Crash logs and stack traces always lean **bug**.
- Phrasing like "would be nice if…" / "I want to be able to…" leans
  **feature**.
- Phrasing like "how do I…" / "is this supposed to…" leans **question**.

## One-line `reason` examples

Every classification should come with a `reason` field — one short sentence
citing the signal you relied on. Examples:

- `"contains stack trace and deterministic repro; title says 'crashes when'"`
- `"explicit 'feature request' label and asks for a new API"`
- `"reporter asks how to configure X, no defect implied"`
- `"tracking meta-issue with checkboxes, not a defect or feature ask"`
