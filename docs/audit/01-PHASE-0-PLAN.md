# Phase 0 — De-risk the "Skill Runner" reposition

**Goal:** validate that user-supplied `.cezar/skills/*.md` files actually improve UX, without breaking anything or committing to the full reposition.
**Duration:** ~1 week.
**Reversibility:** every change is additive; if Phase 0 feels wrong, revert and the existing flows still work.

---

## Step 1 — Wire up the dead `skillsDir` field

**Files:**
- `packages/core/src/config/config.model.ts:73` — already defines `skillsDir: z.string().default('.cezar/skills')`. Leave the schema; just start using it.
- `packages/core/src/config/loader.ts` — add a `loadSkills(config)` function that:
  - Resolves `config.skillsDir` against `config.repoRoot`.
  - Globs `*.md` files.
  - Parses YAML frontmatter (use `gray-matter`, already a transitive dep — confirm before adding).
  - Returns `Map<string, Skill>` where the key is the frontmatter `name` field.

**Skill type (new):**
```ts
// packages/core/src/types/skill.ts
export interface Skill {
  name: string;          // unique id, e.g. "missing-info"
  description?: string;
  stage?: string;        // optional — for Phase 1 stage routing
  body: string;          // Markdown body, used as system-prompt append
  filePath: string;      // for diagnostics
}
```

**Acceptance:**
- `npm run typecheck` clean.
- New unit test: dropping a `.cezar/skills/test.md` into a fixture repo causes `loadSkills()` to return it.

---

## Step 2 — Inject skill into ONE action (`missing-info`)

**Why missing-info:** it's the most tone-sensitive action (drafts comments back to issue authors), so a maintainer's voice override is the most visible win. Lowest risk because it doesn't close issues.

**Files:**
- `packages/core/src/actions/missing-info/prompt.ts` — change `buildMissingInfoPrompt(issue, ...)` signature to accept an optional `skill?: Skill`. When present, append `skill.body` to the system prompt with a `\n\n## Repo-specific guidance\n\n` separator.
- `packages/core/src/actions/missing-info/runner.ts` — accept skills map, look up `skills.get('missing-info')`, pass to `buildMissingInfoPrompt`.
- `packages/cli/src/commands/run.ts` — call `loadSkills(config)` and thread the result down.

**Acceptance:**
- Without `.cezar/skills/missing-info.md`, behavior is byte-identical to today.
- With a skill file containing "Always link to CONTRIBUTING.md", drafted comments include that link.
- Manual test: run on 1 real issue with and without a skill file, diff the comment.

---

## Step 3 — Migrate autofix's three hardcoded skills to files

**Why:** zero behavior change, but proves the file-based model works for the hardest case (autofix), and gets users a working example library.

**Files:**
- `packages/core/src/actions/autofix/skills.ts` — currently exports `ROOT_CAUSE_ANALYSIS_SKILL`, `FIX_IMPLEMENTATION_SKILL`, `CODE_REVIEW_SKILL` as string constants.
- New: `packages/core/src/actions/autofix/builtin-skills/{root-cause,fix,review}.md` — same content as the constants, with frontmatter `name: autofix-root-cause` etc.
- `packages/core/src/actions/autofix/skills.ts` — replace constants with a function that reads the bundled files at module-load (use `fs.readFileSync` against a path resolved with `import.meta.url`).
- `packages/core/src/actions/autofix/prompts/{analyzer,fixer,reviewer}.ts` — no change in behavior; if a user-supplied skill of the same name exists in `.cezar/skills/`, it overrides the bundled one.

**Acceptance:**
- Existing autofix integration test still passes byte-for-byte (the prompt strings reaching Claude are identical).
- Dropping `.cezar/skills/autofix-root-cause.md` overrides the bundled one (verified via prompt-snapshot test).

---

## Step 4 — Add an autofix-mode toggle in GUI Settings

**Why:** independent from skills, but it's a visible UX win that takes ~50 lines and removes a documented papercut (mode currently only changeable via direct DB mutation).

**Files:**
- `packages/gui/src/app/settings/page.tsx` — add a card "Autofix loop mode" with three radio buttons (`off`, `notify`, `autonomous`).
- `packages/gui/src/data/workspaces.ts` — add `updateAutofixMode(workspaceId, mode)` server action. Guard with admin role.
- New migration: not needed — column already exists.

**Acceptance:**
- Admin can flip mode from Settings; non-admins see the field as read-only.
- Dashboard `AutofixLoopCard` reflects the new mode within 1 page reload.

---

## Step 5 — Hide the six speculative actions behind a flag

**Why:** clears the menu before any reposition, makes the remaining actions look like the actual product, frees mental load.

**Files:**
- `packages/cli/src/ui/hub.ts` — filter the menu by `config.experimental === true` for: `categorize`, `bug-detector`, `issue-check`, `needs-response`, `release-notes`, `milestone-planner`.
- `packages/core/src/config/config.model.ts` — add `experimental: z.boolean().default(false)`.
- `README.md` — move these six to a "Experimental" section with a note that they may be removed.

See `02-DELETION-CANDIDATES.md` for the rationale.

**Acceptance:**
- Default hub shows ~12 actions, not 18.
- `experimental: true` in config restores all 18.

---

## What Phase 0 deliberately does NOT do

- **Does not** redesign the hub-as-queue (that's a Phase 1+ change with bigger UX surface).
- **Does not** consolidate the six cron endpoints (that's a refactor, not a UX change).
- **Does not** change the comment format or merge multi-action comments.
- **Does not** delete any action — only hides six.
- **Does not** change the GUI dashboard layout or cockpit.

---

## Decision gate after Phase 0

After ~1 week, you have:
- One action that loads a user-supplied skill file.
- Autofix's three skills in editable files.
- A settings UI for mode.
- A clean menu of 12 actions.

**Decide:**
1. **Skill injection on `missing-info` produced visibly better comments?** → commit to Option B Phase 1 (extend pattern to all actions).
2. **It worked but felt like overkill?** → keep Phase 0 changes, stay on Option A (Triage Copilot), don't push further.
3. **It didn't help / felt brittle?** → revert just the skill loader (Steps 1–3); the menu cleanup and mode toggle (Steps 4–5) are wins regardless.

The Phase 0 changes are isolated enough that any of those three outcomes is recoverable.
