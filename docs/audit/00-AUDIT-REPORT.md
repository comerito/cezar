# Cezar — Strategic UX & Direction Audit

**Date:** 2026-05-06
**Scope:** Full codebase audit of `packages/cli`, `packages/core`, `packages/gui`, and the issue-driven autofix loop.
**Method:** Three parallel exploration passes (CLI surface, GUI/autofix, skill extensibility) plus direct reads of `CEZAR-ARCHITECTURE-FOR-GUI.md` and `cezar-ROADMAP.md`.

---

## TL;DR

Cezar's chaos isn't 18 bad features — it's **18 features competing for the same UX slot** when the product needed *one* slot. The slot the user wants is **"run my repo's `.claude/skills/*` on my GitHub issues"**, with the existing actions as example skills. The plumbing is half-built (`Config.skillsDir` exists but is dead code) and the autofix loop already proves the orchestration model works. Recommend **Option B (Skill Runner)**, sequenced via a 1-week Phase 0 that's safe to abandon if it doesn't feel right.

---

## 1. What's actually in the box

| Surface | Reality |
|---|---|
| **CLI actions** | **18 registered** (README claims 14). 10 mutate GitHub, 8 are display-only — `release-notes`, `milestone-planner`, `bug-detector`, `issue-check`, `needs-response`, `categorize`, `claim-detector`, `priority` |
| **CLI hub** | Single flat menu of every action with badges. Typical workflow = 10+ keystrokes per item |
| **CLI commands** | `init / sync / status / run / pipeline` + many flags, several of which silently no-op for actions that don't support them (e.g., `--state`, `--format`) |
| **GUI** | Next.js + Supabase, multi-tenant. Re-implements core via `SupabaseStoreAdapter` — not a thin wrapper |
| **Autofix loop** | **6 separate Vercel cron endpoints** (`issue-sync`, `issue-match`, `issue-fix`, `ci-watch`, `ci-attribute`, `ci-fix`) wired together with status flags on `issue_autofix_candidates` |
| **Skill plumbing** | `Config.skillsDir = ".cezar/skills"` exists in `packages/core/src/config/config.model.ts:73` and **is never read by any code**. Dead field. |
| **Prompts** | Every `packages/core/src/actions/*/prompt.ts` is hardcoded. No override path. Autofix's three skills are string constants in `actions/autofix/skills.ts` |
| **Comments** | Consistent footer (`🤖 CEZAR update — <ts>`) via `services/audit.ts`, but body content style varies wildly — `duplicates` posts a one-liner, `missing-info` posts an LLM-drafted essay |

### Action inventory (full)

| Action | Runner LOC | GitHub Mutations | Verdict |
|---|---|---|---|
| `duplicates` | 117 | Close + Comment | **Keep** — core value |
| `auto-label` | 138 | Comment footer | **Keep** — high frequency |
| `missing-info` | 123 | Comment + Label | **Keep** — high frequency |
| `recurring-questions` | 139 | Close + Comment | **Keep** |
| `done-detector` | 200 | Close + Comment | **Keep** |
| `stale` | 157 | Close + Comment | **Keep** |
| `priority` | 125 | Comment footer | Reduce — display-only is weak |
| `quality` | 132 | Close + Comment footer | Reduce — overlaps with missing-info |
| `security` | 136 | Comment | Keep, but rare-fire |
| `good-first-issue` | 122 | Comment | Keep |
| `contributor-welcome` | 121 | Comment | Keep |
| `claim-detector` | 132 | Comment | Reduce — niche |
| `categorize` | 114 | Comment footer | **Drop** — overlaps with bug-detector |
| `bug-detector` | 118 | Display only | **Drop** — overlaps with categorize |
| `issue-check` | 79 | Display only | **Drop** — wrong audience (issue authors, not maintainers) |
| `needs-response` | 122 | Display only | **Drop** — list with no escalation |
| `release-notes` | 133 | Display only | **Drop** — generates Markdown that goes nowhere |
| `milestone-planner` | 89 | Display only | **Drop** — doesn't apply milestones |
| `autofix` | 213 | Opens PR + comments | **Promote** — best per-issue value |

See `02-DELETION-CANDIDATES.md` for the deletion plan.

---

## 2. Why the UX feels chaotic — root causes

### (a) Feature surface outran the product thesis
The original spec promised "find duplicates well." It became 18 actions because each was easy to add (the plugin pattern is *too* welcoming). Six are speculative: `milestone-planner` doesn't apply milestones; `release-notes` generates Markdown that goes nowhere; `needs-response` is a list with no escalation; `issue-check` targets *issue authors*, not maintainers (wrong user).

### (b) Two parallel UIs that re-implement the same flows
CLI hub and GUI dashboard each show the action grid, sync state, and per-issue review — but the GUI uses Supabase as the store while the CLI uses a JSON file, so config, state, and event handling are doubled. ~3,500 lines of GUI just to mirror the CLI.

### (c) The autofix loop is a state machine pretending to be cron jobs
Six cron handlers with no transactional guard, no "stalled candidate" view, no retry backoff on stage failure. If `issue-match` fails once, rows sit in `pending_match` forever. Mode (`off | notify | autonomous`) lives only in the DB — there's no settings UI to flip it.

### (d) "Communication" was solved at the *footer* level, not the *content* level
Every comment gets `🤖 CEZAR update`, but the body is whatever the per-action prompt happened to produce that day. There's no shared "voice" or maintainer-defined tone. There's no link back to the analysis, no "reply to dispute" affordance, no consolidation when multiple actions fire on the same issue.

### (e) Zero extensibility for the user's own knowledge
A maintainer cannot tell Cezar "our tests are Mocha not Jest", "our duplicate rule is component-scoped", or "use our CONTRIBUTING tone". Every prompt is yours, hardcoded, in TS. The dead `skillsDir` field is a fossil of an intent that never shipped.

---

## 3. Three strategic directions

These are not mutually exclusive in pieces, but each implies a different center-of-gravity for the product.

### Option A — "Triage Copilot" (incremental, stay in lane)
Ruthlessly cut to ~5 actions that genuinely save maintainer time: `duplicates`, `missing-info`, `stale`, `done-detector`, `auto-label`. Delete the rest. Make the hub a *queue*, not a menu — it shows you the next 10 issues that need *your* decision, regardless of which "action" produced them. One unified comment per issue ("Cezar review: 3 findings"), not three separate comments.

- **Pros:** smallest change; ships in 1–2 weeks; immediate UX win
- **Cons:** doesn't solve "no skills" complaint; autofix becomes orphan; doesn't differentiate from Sweep/Probot/etc.
- **Best if** you want to validate the core thesis before betting bigger.

### Option B — "Skill Runner" (the repositioning the user is hinting at)
Reframe Cezar as: **"your `.claude/skills/*.md` running autonomously on your GitHub issues."** A skill is the unit of work. The 18 actions collapse into ~4 *built-in skills* (triage, request-info, autofix, welcome) shipped as example `.md` files in `.cezar/skills/` that the user can edit, replace, or extend. Stages of the pipeline (`detect → propose → comment → act`) each accept a skill override, so a repo can plug its own `our-duplicate-rules.md` into the duplicate stage.

The product surface becomes:
- **One CLI command:** `cezar run` walks every open issue through the user's skills.
- **One GUI page:** issue table with per-row skill outcomes + activate buttons.
- **Settings tab:** list of skills, their stage, enabled/disabled, last-run.

Autofix becomes "a skill that uses Edit/Bash tools" — same UX as any other skill, no special framework around it.

- **Pros:** solves all five user complaints in one move (chaos, feature-bloat, complex autofix, no-skill-support, comment voice via skill prompts). Massive differentiation — nobody else does this. Reuses the existing Agent SDK plumbing.
- **Cons:** ~3 weeks of work; requires migrating hardcoded prompts to skill files; need to design the skill schema (frontmatter for `stage`, `tools`, `confirm`, `comment-template`); breaking change for existing users.
- **Best if** you want a defensible product story ("Cezar = Claude Skills for your repo's issues") and are willing to delete code.

### Option C — "Autofix-First, Triage Optional"
Bet the company on the autofix loop. Everything else (duplicates, labels, etc.) becomes peripheral. Invest in: skill injection for analyzer/fixer/reviewer, a real cockpit, mode toggle UI, preflight modal, retry/backoff. Drop or freeze the 17 other actions. Repo maintainers install Cezar **to fix bugs from issues**.

- **Pros:** highest user value per issue (saved engineer-hours). Clear positioning. Smallest action surface.
- **Cons:** competing with well-funded players (Sweep, Devin, OpenHands, Aider). Quality bar is brutal — one bad PR per repo and you lose trust. Doesn't reuse the triage work.
- **Best if** you have strong belief autofix can hit production-quality and want to compete head-on in coding-agent space.

---

## 4. Recommendation: Option B, sequenced

The user's complaints all point at the same thing: Cezar grew an *action surface* when it needed an *extension surface*. The presence of `skillsDir` in config and `skills.ts` in autofix shows the team already half-thought about it.

**Phase 0 (~1 week)** is laid out in `01-PHASE-0-PLAN.md`. It validates the skill model on one action without committing to the full reposition.

After Phase 0, if it feels right:
- **Phase 1 (2 weeks):** Every action prompt loads from `.cezar/skills/<action>.md` with a built-in default. Add Skills tab to GUI.
- **Phase 2 (1 week):** Migrate autofix's three hardcoded skills (`ROOT_CAUSE_ANALYSIS_SKILL`, `FIX_IMPLEMENTATION_SKILL`, `CODE_REVIEW_SKILL`) to user-overridable files.
- **Phase 3 (2 weeks):** New skill schema with `stage` + `tools` frontmatter. Built-in actions become reference skills. Drop the action plugin system in favor of skill discovery.

---

## 5. Companion documents

- `01-PHASE-0-PLAN.md` — Concrete week-1 plan (de-risks Option B)
- `02-DELETION-CANDIDATES.md` — Six speculative actions to retire, with file paths
- `03-UX-QUICK-WINS.md` — Orthogonal fixes worth doing regardless of direction
