---
name: root-cause-analysis
description: Localize the root cause of a reported bug before attempting any fix.
---

# Root Cause Analysis

Use this skill before changing a single line of code. The goal is to form a defensible, testable hypothesis about *why* the bug happens — not *what* to do about it yet.

## Procedure

1. **Read the issue in full.** Title, body, all comments, any stack traces, any linked issues or PRs. Do not skim.
2. **Restate expected vs. actual behavior** in one sentence each. If you can't, the issue is ambiguous — read it again before guessing.
3. **Identify the entry point.** Which command, API, file, or user action triggers the bug? Use `Grep` for unique strings (error messages, function names, CLI flags) from the report.
4. **Walk the code path from the entry point.** `Read` every file on the path end-to-end. Do not skim to the first suspicious line — understand the surrounding context.
5. **State the hypothesis.** Write a 2-4 sentence explanation that would let a reader reproduce the bug on paper without running anything.
6. **Sanity-check against the evidence.** Does your hypothesis explain *every* symptom in the report, including any error messages and comments? If not, refine or discard.

## Confidence calibration

- `>= 0.9` — you have read the faulty code, you can point to the exact line, and your hypothesis explains every symptom.
- `0.7 - 0.9` — you have a specific file + function but haven't confirmed the exact line.
- `0.5 - 0.7` — you have a plausible area but alternatives remain.
- `< 0.5` — you're guessing. Say so. Do not oversell certainty; a low-confidence honest diagnosis is more useful than a confident wrong one.

## Anti-patterns to avoid

- **Pattern-matching to a similar bug you once saw.** Verify in *this* codebase.
- **Stopping at the first suspect file.** Often the bug is one or two call-sites deeper.
- **Proposing a fix before the hypothesis is stable.** Fixing is a separate phase.
- **Changing code during analysis.** This phase is read-only.

## Deliverable

When finished, output the structured JSON requested by the caller. Do not include analysis prose outside the JSON.
