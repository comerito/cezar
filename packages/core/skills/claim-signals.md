---
name: claim-signals
description: Patterns for spotting issues where a contributor claimed to take it but went silent.
cezar-stages:
  - claim-detector
---

# Claim-detection signals

Goal: find issues where someone publicly claimed they'd work on it, then
disappeared — so a maintainer can nudge them or reopen for grabs.

## Strong claim signals

The most explicit phrasings:
- "I'll take this", "I'll work on this", "I can pick this up", "Assigning
  myself", "I'm on it", "On it!", "Working on this".
- "PR coming soon", "Submitting a PR today", "Will open a PR by …".
- "Mind if I take this?" followed by maintainer ack with no PR.

## Soft claim signals

Weaker but still worth surfacing:
- "Started working on this", "Have a local fix", "Branch up at …".
- "Looking into this" (from a non-maintainer, with no follow-up).
- Self-assignment via `/assign` command followed by no commits.

## How to evaluate "went silent"

- Claim timestamp older than **14 days** with no PR referencing the issue.
- No further comments from the claimant in that window.
- No assignee removal / explicit handoff.

## Output

For each match:
- `claimant` — the GitHub username who claimed.
- `claimed_at` — timestamp of the claim comment.
- `days_silent` — days since the claim with no follow-through.
- `suggested_nudge` — a polite comment template: thank the claimant, ask
  if they're still working on it, offer to free up the issue otherwise.

Be kind in the nudge — contributors disappear for legitimate reasons.
