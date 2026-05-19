---
name: recurring-question-patterns
description: Patterns for recognising that an open question has already been answered in a closed issue.
cezar-stages:
  - recurring-questions
---

# Recurring-question patterns

For each **open question**, decide whether a substantially similar question
was already answered in the closed-issue knowledge base.

## Match criteria

- The closed issue genuinely **answers** the open question — not merely
  shares keywords.
- The suggested response **must reference the closed issue(s) by number**.
  Never invent answers.
- Summarise what the closed issue covers so the user gets immediate value
  without clicking through.

## When a match isn't recurring

- If the answer is already provided in the open issue's **comments**, set
  `isRecurring: false` — no need to redirect.
- If the closed issue is only tangentially related, omit it. Don't lower
  your confidence just to fit a match.
- If the open question has clear novelty (new version, different platform,
  edge case the closed issue didn't cover), it's not recurring.

## Confidence

Reflects how well the closed issue(s) actually answer the open question.
Be willing to set `isRecurring: false` with no matches rather than
forcing a low-confidence link.

## Suggested-response shape

```
This has been answered before! Check out:

- #45 covers timeout configuration in detail
- #89 has additional context on request timeouts

Closing as answered — feel free to reopen if your question is different.
```
