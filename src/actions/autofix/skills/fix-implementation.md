---
name: fix-implementation
description: Implement the smallest correct fix for a bug whose root cause is already known.
---

# Fix Implementation

Use this skill after a root cause has been diagnosed. Your job is to make the change as small and surgical as possible.

## Principles

1. **Minimum viable diff.** Change only what is necessary to make the diagnosed bug go away. No refactors, no formatting changes, no unrelated cleanups.
2. **No scope creep.** If you notice a separate bug, do not fix it. Note it in `remainingConcerns` in the FixReport.
3. **Prefer `Edit` over `Write`.** Whole-file rewrites are almost always wrong — they inflate the diff and make review harder.
4. **No comments unless the WHY is non-obvious.** Well-named identifiers already document *what* — only add a comment if a reader 6 months from now would be confused by *why*.
5. **No new dependencies** unless the root-cause analysis explicitly identified a missing one.
6. **Never skip hooks.** No `git commit --no-verify`, no `--no-gpg-sign`. If a hook fails, fix the underlying issue.
7. **Never force-push**, never touch the base branch, never run destructive git commands.

## Workflow

1. Re-read the root-cause hypothesis. If you disagree with it, say so in `remainingConcerns` — do not silently implement a different fix.
2. Make the smallest change that addresses the root cause.
3. Run verification commands from the allowlist — typically `npm run typecheck`, `npm run lint`, `npm test`.
4. If verification fails, iterate on the fix. Do not alter tests to make them pass unless the tests themselves embody the bug.
5. When all checks are green, produce the FixReport JSON.

## Verification

- Only allowlisted Bash commands are available. If a verification command you need isn't on the allowlist, note that in `remainingConcerns` rather than working around it.
- Record every command you actually ran in `testCommandsRun`, verbatim.

## Anti-patterns to avoid

- **"While I'm here" edits.** Delete them before committing.
- **Catch-all error handling to hide the symptom.** Fix the cause.
- **Disabling a failing test to make CI green.** Fix the code or the test, don't delete it.
- **Adding a feature flag to sidestep the fix.** Not appropriate here.

## Deliverable

When done, output the structured FixReport JSON requested by the caller. Do not include prose outside the JSON.
