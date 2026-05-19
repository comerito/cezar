---
name: quality-rubric
description: Rubric for identifying low-quality issue submissions that waste maintainer time.
cezar-stages:
  - quality
---

# Submission-quality rubric

Identify submissions that waste maintainer time. Be **conservative** — when
in doubt, mark as `ok`. A short but clear issue is not a low-quality one.

## Categories

- **spam** — Promotional content, SEO links, completely unrelated to the
  project. Suggest label `invalid`.
- **vague** — No actionable information. Examples: "it doesn't work",
  "help me", "broken". No steps, no context, no details. Suggest label
  `needs-info`.
- **test** — Accidental or test submissions. Examples: "asdf", "test
  issue", "aaa", empty or near-empty body. Suggest label `invalid`.
- **wrong-language** — Written in a language other than the repository's
  primary language. Only flag if the repo clearly uses one language.
  Suggest label `invalid`.
- **ok** — Legitimate issue with enough substance to be actionable. No
  suggested label.

## Non-rules (things that look bad but aren't)

- Short issues are not vague when they're clear: "Button X crashes on
  click" is fine without elaborate steps.
- Issues with code snippets, error messages, or screenshots are rarely
  vague.
- Feature requests can be brief — "Add dark mode" is valid without
  detailed requirements.
- A foreign-language word in an otherwise-English issue is not
  `wrong-language`.

## When marking spam

Only flag as spam if the content is clearly promotional, completely
off-topic, or part of an SEO link campaign. A poorly-written but
on-topic issue is **vague**, not spam.
