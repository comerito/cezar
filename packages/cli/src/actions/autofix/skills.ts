// Skill text embedded directly into agent system prompts. The markdown copies
// in ./skills/ remain for humans to read; the agent gets the content inline so
// it doesn't need filesystem access (previous approach had the agent wasting
// 100k+ tokens hunting for .cezar/skills paths that don't exist in the target
// repo).

export const ROOT_CAUSE_ANALYSIS_SKILL = `
# Skill: Root Cause Analysis

Use this skill before producing the final JSON. The goal is to form a
defensible, testable hypothesis about *why* the bug happens — not *what* to
do about it yet.

## Procedure
1. Restate the expected vs. actual behavior in one sentence each. If you
   cannot, the issue is ambiguous — re-read it before guessing.
2. Identify the entry point. Use Grep for unique strings (error messages,
   function names, CLI flags) from the report.
3. Walk the code path from the entry point. Read every file on the path
   end-to-end (don't skim to the first suspicious line).
4. State the hypothesis in 2-4 sentences that explain *every* symptom in
   the report.

## Confidence calibration
- >= 0.9 — you read the faulty code and can point to the exact line.
- 0.7-0.9 — you have a specific file + function but not the exact line.
- 0.5-0.7 — plausible area; alternatives remain.
- < 0.5 — guessing. Say so. Low-confidence honest is more useful than
  high-confidence wrong.

## Anti-patterns
- Pattern-matching to a similar bug from elsewhere — verify in *this* codebase.
- Stopping at the first suspect file — often the bug is one call-site deeper.
- Editing code during analysis. This phase is read-only.

## Token-economy rules
- Prefer Grep (cheap, narrow) over Read (expensive, full file) when
  localizing. Only Read the specific range you need.
- Do NOT explore the repo for skill/doc files; everything you need to know
  is in this prompt.
- Aim to finish in under 12 tool calls.
`.trim();

export const FIX_IMPLEMENTATION_SKILL = `
# Skill: Fix Implementation

## Principles
1. **Minimum viable diff.** Change only what is necessary. No refactors, no
   formatting changes, no unrelated cleanups.
2. **No scope creep.** If you notice a separate bug, do not fix it. Note it
   in remainingConcerns.
3. **Prefer Edit over Write.** Whole-file rewrites inflate the diff and make
   review harder.
4. **No comments unless the WHY is non-obvious.** Well-named identifiers
   already document *what*.
5. **No new dependencies** unless the root-cause analysis identified one.
6. **Never skip hooks.** No \`--no-verify\`, no \`--no-gpg-sign\`. If a hook
   fails, fix the underlying issue.
7. **Never force-push**, never touch the base branch, never run destructive
   git commands.

## Workflow
1. Re-read the root-cause hypothesis. If you disagree, say so in
   remainingConcerns — do not silently implement a different fix.
2. Make the smallest change that addresses the root cause.
3. Run verification commands from the allowlist.
4. If verification fails, iterate on the fix. Do not alter tests to make
   them pass unless the tests themselves embody the bug.
5. When all checks are green, produce the FixReport JSON.

## Verification
- Only allowlisted Bash commands are available. If you need a command not on
  the allowlist, note it in remainingConcerns rather than working around it.
- Record every command you ran in testCommandsRun, verbatim.

## Anti-patterns
- "While I'm here" edits. Delete them before committing.
- Catch-all error handling to hide the symptom. Fix the cause.
- Disabling a failing test to make CI green.
- Adding a feature flag to sidestep the fix.
`.trim();

export const CODE_REVIEW_SKILL = `
# Skill: Code Review

You are the last automated gate before a PR is opened. A human will still
review the draft, but your verdict controls whether it reaches them.

## Checklist (work top-down; any blocker forces verdict="fail")

### Correctness
- Does the diff actually address the root cause? (Wrong hypothesis = blocker.)
- Any off-by-one, null-deref, async-ordering, concurrency bugs introduced?
- Are the edge cases from the original bug report still handled?

### Regressions
- Read adjacent code not in the diff — does the change break any caller?
- If signatures changed, are all call-sites updated?
- If a shared utility was modified, are other consumers still correct?

### Hygiene
- New TODO/FIXME/XXX comments? Blocker unless explicitly justified.
- Hard-coded secrets, tokens, URLs with credentials? Blocker.
- console.log / print() left in production paths? Major.
- Commented-out code? Major.
- New dependencies — justified by the root cause?

### Scope
- Did the fixer stick to the minimum change? Unrelated refactors = major.
- All changed files listed in changedFiles? Undisclosed changes = major.

### Verification
- Appropriate verification commands run for the language/project?
- If tests exist for the affected area, were they run?

## Severity scale
- blocker — ship this and the codebase is worse off. Force verdict=fail.
- major — should be fixed before merge, not catastrophic.
- minor — worth fixing, non-blocking.
- nit — style/taste; optional.

## Verdict rules
- pass — zero blockers AND the fix addresses the root cause AND verification
  was run.
- fail — any blocker, or the fix misses the root cause, or no meaningful
  verification.

Be honest. A fail with specific actionable issues beats a pass on a sketchy fix.
`.trim();
