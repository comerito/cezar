# Cezar — Product Roadmap

## Prioritization Framework

Every feature is scored on three axes before inclusion:

- **Time saved** — how many minutes/hours per week does this recover for an active maintainer?
- **Frequency** — how often does the pain occur? (per issue, per week, per release)
- **Automation quality** — can AI do this reliably enough that a human doesn't need to double-check every result?

Features that rank low on automation quality are deprioritized regardless of time saved — a tool that requires constant correction wastes more time than it saves.

---

## The Real Daily Cost of Maintaining a GitHub Repo

Based on surveying common maintainer workflows, a typical active open source project costs:

| Activity | Frequency | Time Cost |
|---|---|---|
| Reading + categorizing new issues | Per issue | 3–5 min each |
| Chasing missing reproduction info | ~40% of bug reports | 10–20 min per back-and-forth |
| Hunting and closing duplicates | Daily | 5–15 min |
| Responding to recurring questions | Weekly | 20–40 min |
| Triaging: deciding what to work on | Weekly | 30–60 min |
| Closing stale issues with grace | Monthly | 30–60 min |
| Preparing release notes | Per release | 1–3 hours |
| Tagging good first issues | Monthly | 20 min |
| Spotting security issues in the noise | Rare but critical | — |

Cezar targets the top three rows first (highest frequency × highest time cost), then works down.

---

## Phase 1 — Foundation ✅ (Designed)

**Goal:** Make the backlog legible. Reduce noise. Establish the local store as a reliable foundation.

### `init` + `sync`
Fetch all issues, generate digests, persist to local store. Incremental sync with content-change detection.
**Time saved:** Indirectly enables everything below.

### Action: Find Duplicates
AI scans all open issues for semantic duplicates using compact digest comparisons.
**Time saved:** 5–15 min/day for active repos.
**Why first:** Duplicates are pure noise. Closing them reduces the backlog maintainers must look at every day. Highest signal-to-noise improvement per action.

**Outcome of Phase 1:** A maintainer who had 180 issues gets to ~140 real unique issues and knows their store is accurate.

---

## Phase 2 — Daily Triage Automation

**Goal:** Automate the most repetitive per-issue tasks so a maintainer spends 5 seconds per new issue instead of 5 minutes.

### Action: Missing Information Request
**Time saved: 10–20 min per bug report · Frequency: ~40% of all bugs**

The single biggest time drain that nobody talks about. A bug is filed with no version number, no reproduction steps, no OS info. You write a polite comment asking for them. The user takes 3 days to respond. You check back. Etc.

Cezar detects when a bug report is missing critical information and either:
- Posts an automated comment with specific questions (e.g. "Could you share: 1. Your Node.js version 2. Minimal reproduction steps 3. Expected vs actual behavior?")
- Labels the issue `needs-info` and adds it to a watchlist
- After N days with no response, automatically closes with a template message

What makes this AI-powered rather than just a template: Claude reads the issue and identifies *specifically what is missing*. A database issue gets asked for schema and query. A UI issue gets asked for browser and OS. Not a generic template.

```
issue-manager run missing-info --auto-comment --close-after 14d
```

**Automation quality: HIGH** — False positives (asking for info that's already there) are annoying but recoverable. False negatives (not asking) just means the maintainer handles it manually as before. Risk is low.

---

### Action: Auto-Label
**Time saved: 3–5 min per issue · Frequency: Every new issue**

Consistent, semantic labeling based on issue content. Not keyword matching — Claude reads the issue and applies labels from your repo's label set.

Handles:
- Type labels: `bug`, `enhancement`, `documentation`, `question`, `security`
- Area labels: inferred from content (e.g. `area: auth`, `area: checkout`, `area: api`)
- Priority labels: `priority: critical` when issue describes data loss, security, or production down

The key insight: most repos have 30–50 labels but only 10–15 get applied consistently. Cezar normalizes label application across the whole backlog in one run.

```
issue-manager run label --apply --dry-run
```

**Automation quality: HIGH** for type labels, **MEDIUM** for area labels (depends on how well-defined repo areas are). Always show a diff before applying.

---

### Action: Recurring Question Detection
**Time saved: 20–40 min/week · Frequency: Constant in any popular project**

A large percentage of issues in active projects are questions that have been answered before — either in docs, in closed issues, or in the README. Maintainers answer the same 15 questions repeatedly.

Cezar:
1. Identifies issues that are questions (not bugs or features)
2. Searches the store for similar closed issues that were resolved
3. Suggests a response linking to the existing answer
4. Optionally posts the comment and closes the issue as `not planned` / `answered`

The interaction:
```
? Issue #234 looks like a recurring question:
  "How do I configure the timeout?"
  
  Similar closed issues:
  → #45 "Timeout configuration" — answered 8 months ago
  → #89 "Request timeout setting" — answered 5 months ago
  
  Suggested response: [preview shown]
  
  What do you want to do?
  ❯ Post response + close issue
    Post response, leave open
    Edit response first
    Skip
```

**Automation quality: HIGH** — linking to prior answers is verifiable. Claude doesn't invent answers, it finds existing ones.

---

## Phase 3 — Triage Intelligence

**Goal:** Help the maintainer decide *what to work on*, not just clean up noise.

### Action: Priority Score
**Time saved: 30–60 min/week · Frequency: Weekly triage session**

Assign `critical / high / medium / low` to every open issue based on:
- Severity described in the issue text
- Number of people affected (reactions + comment count as signals)
- Whether it's a regression vs new feature
- Keywords indicating user impact: "data loss", "crash", "broken in production", "security"
- Category weight: security > data correctness > core functionality > UX > nice-to-have

Interactive review: maintainer sees the AI's reasoning and can override before labels are applied.

```
#89  critical  ████  Data loss when migrating — users report records deleted
#12  high      ████  Login broken on Safari iOS — affects ~15% of mobile users  
#67  high      ███   Performance regression in v2.3 — 3x slower than v2.2
#34  medium    ██    Dropdown z-index overlaps modal on small screens
#201 low       █     Add dark mode option
```

**Automation quality: MEDIUM-HIGH** — Priority is subjective. Claude's reasoning is shown for every decision. The value is not perfect automation but *speed*: reviewing AI-suggested priorities is 5× faster than assigning them from scratch.

---

### Action: Good First Issue Tagging
**Time saved: 20–30 min/month · Frequency: Ongoing, matters for community growth**

Identifies issues suitable for new contributors based on:
- Self-contained scope (doesn't require understanding the whole codebase)
- Clear acceptance criteria (what "done" looks like is obvious)
- No dependency on unresolved architectural decisions
- Estimated complexity: small (< 1 day of work for someone unfamiliar with the codebase)

Adds `good first issue` label and optionally posts a comment with a hint about where to look in the codebase (if the affected area is identified in the digest).

**Automation quality: MEDIUM** — Claude can assess scope well but can't know which parts of the codebase are actually hard. Requires human review before applying. Still saves time vs reading every issue manually.

---

### Action: Security Triage
**Time saved: Variable, but prevents disasters**

Scans all open issues for potential security implications that may not be labeled as such. Security issues are frequently filed as regular bugs.

Detects language around:
- Authentication bypass, session hijacking, privilege escalation
- Injection vectors (SQL, command, path traversal)
- Sensitive data exposure, logging of credentials
- Dependency vulnerabilities mentioned in passing

Flags suspected security issues with:
- `security` label
- Optional: converts to private draft security advisory (GitHub API)
- Sends a summary to the maintainer immediately (print to terminal + optional webhook)

The interaction skips review — it just alerts. The maintainer investigates.

```
⚠ SECURITY: 2 issues may contain security implications

  #178  "API key visible in error response"     confidence: 94%
  #203  "Admin panel accessible without login"  confidence: 88%

  These issues have been labeled 'security' and hidden from public view.
  Review them at: https://github.com/open-mercato/core/security/advisories
```

**Automation quality: HIGH for flagging, requires human for resolution** — False positives are acceptable (a maintainer checks an issue unnecessarily). False negatives are costly but the alternative (not checking) is worse.

---

## Phase 4 — Release Workflow

**Goal:** Eliminate the hours spent writing changelogs and preparing releases.

### Action: Release Notes Generator
**Time saved: 1–3 hours per release**

Given a milestone, a date range, or a list of closed issues/PRs, generates structured release notes.

Output format follows conventional changelog style:

```markdown
## v2.4.0 — 2025-03-15

### 🐛 Bug Fixes
- Fix cart total not updating after discount code (#123, #156)
- Resolve Safari iOS login crash (#89)
- Correct timezone handling in date picker (#67)

### ✨ New Features  
- Add OAuth2 Google login support (#34)
- Dark mode support (#201)

### ⚡ Performance
- Reduce initial bundle size by 40% (#145)

### 🔒 Security
- Patch XSS vulnerability in markdown renderer (#178) — thanks @reporter

### 🙏 Contributors
First-time contributors: @alice, @bob, @charlie
```

Cezar reads closed issue digests (not raw bodies) so it produces clean, consistent prose rather than copy-pasting issue titles verbatim.

```
issue-manager run release-notes --milestone v2.4.0
issue-manager run release-notes --since 2025-02-01 --until 2025-03-15
issue-manager run release-notes --issues 89,123,145,178,201
```

**Automation quality: HIGH** — Factual (what was closed), not judgmental. The digest ensures clean language. Editable before publishing.

---

### Action: Milestone Planner
**Time saved: 30–60 min per planning cycle**

Groups open issues into logical release candidates based on:
- Theme clustering (issues about the same feature area)
- Priority (critical/high issues surface first)
- Dependencies (issues that reference each other)
- Estimated effort (derived from issue complexity signals)

Suggests a `v-next` milestone grouping that a maintainer can accept, edit, and apply.

**Automation quality: MEDIUM** — Suggestions are a starting point for a conversation, not final decisions. Value is in the clustering, not the specific grouping.

---

## Phase 5 — Community Health

**Goal:** Reduce maintainer burnout by automating community-facing interactions.

### Action: Stale Issue Cleanup
**Time saved: 30–60 min/month**

Issues with no activity for N days (configurable, default 90) get reviewed:
- If it's a bug: check if it's been fixed by a subsequent commit (via PR linkage)
- If it's a question: check if the question was answered inline
- If it's a feature: check if it was superseded by a different implementation

For each stale issue, Cezar suggests one of:
- Close as resolved (with explanation)
- Close as won't fix (with reasoning)
- Add `stale` label and post a "will close in 14 days unless there's activity" comment
- Keep open (if the issue is still clearly relevant and unresolved)

**Automation quality: MEDIUM** — Requires human review for closes, but the grouping and draft messages save significant time.

---

### Action: Contributor Welcome
**Time saved: 5–10 min per new contributor**

When someone files their first issue or PR, posts a personalized welcome comment that:
- Thanks them by name
- Explains the contribution process (links to CONTRIBUTING.md)
- Sets expectations on response time
- If it's a bug: confirms receipt and asks for any missing info in the same message
- If it's a feature: explains the decision process (e.g. "we evaluate features based on...")

Not a generic template — Claude personalizes based on what they filed.

**Automation quality: HIGH** — Low stakes, high warmth. A slightly generic welcome is still better than silence.

---

### Action: Issue Quality Check
**Time saved: Indirect — reduces noise**

Identifies low-quality submissions before a maintainer reads them:
- Spam (unrelated, promotional)
- Vague reports with no actionable information ("it doesn't work")
- Test/accidental submissions
- Issues in wrong language (if repo has a language requirement)

Flags for maintainer review rather than auto-closing. Adds `needs-info` or `invalid` label.

**Automation quality: HIGH for spam, MEDIUM for vague reports** — When in doubt, flag rather than close.

---

## Roadmap Summary

```
Phase 1 ──── FOUNDATION (now)
  ✅ init / sync / store
  ✅ Find Duplicates

Phase 2 ──── DAILY TRIAGE (next)
  → Missing Information Request    HIGH IMPACT — 40% of bugs need this
  → Auto-Label                     HIGH IMPACT — every new issue
  → Recurring Question Detection   HIGH IMPACT — constant pain in popular repos

Phase 3 ──── TRIAGE INTELLIGENCE
  → Priority Score                 helps weekly triage sessions
  → Good First Issue Tagging       community growth
  → Security Triage                prevents disasters

Phase 4 ──── RELEASE WORKFLOW
  → Release Notes Generator        1–3 hours saved per release
  → Milestone Planner              planning cycle efficiency

Phase 5 ──── COMMUNITY HEALTH
  → Stale Issue Cleanup            monthly maintenance
  → Contributor Welcome            onboarding quality
  → Issue Quality Check            noise reduction
```

---

## Explicit Non-Goals

These are features that seem useful but are excluded deliberately:

**Auto-closing issues without review.** Cezar never closes an issue without a human seeing and approving it. Mistakenly auto-closing a valid user report is a trust-destroying event for a project.

**Answering technical questions with AI-generated solutions.** Generating code or solutions to post as issue comments is out of scope. Cezar links to existing answers, it doesn't fabricate new ones.

**Pull request review.** Out of scope for v1. The store model is issue-centric. PRs have a fundamentally different lifecycle.

**Real-time webhook listener.** Cezar is a pull-based tool (you run `sync` when you want to). A webhook listener that runs automatically is a separate deployment concern and out of scope. GitHub Actions handles that use case.

**Analytics dashboards.** Issue velocity, contributor graphs, response time metrics — valuable but separate from the triage use case. Cezar is about reducing backlog, not measuring it.
