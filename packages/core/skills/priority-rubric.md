---
name: priority-rubric
description: Rubric for assigning impact-and-urgency priority levels to issues.
cezar-stages:
  - priority
---

# Priority rubric

Assign exactly one priority level per issue. Cite specific evidence from the
issue text in your reasoning — generic claims like "looks important" are not
acceptable.

## Levels

- **critical** — data loss, security vulnerability, production down, or
  affects the majority of users.
- **high** — regression, broken core functionality, or affects a significant
  user segment.
- **medium** — non-critical bug, UX issue, or affects a subset of users.
- **low** — enhancement, nice-to-have, cosmetic fix, or edge case.

## Signal sources

- Comment count and reactions are **engagement signals**: a higher count
  generally indicates more impact, though loud minorities also exist.
- Comment content often reveals urgency, affected-user count, and the
  availability of workarounds — read it.
- Enhancement requests are generally **low** unless they address a
  significant gap that blocks a meaningful workflow.

## Calibration rules

- Be conservative with **critical** — reserve it for genuine emergencies.
- "Crashes / data loss / locked out" wording leans **critical**.
- "Slow / awkward / unclear" wording leans **medium** or **low**.
- A label such as `bug` is a signal but not a shortcut — read the body.

## Reason field

One short sentence citing the actual evidence, e.g.:

- `"Login broken on Safari iOS affects ~15% of mobile users"`
- `"Visual glitch in a rarely-used onboarding step, no functional impact"`
