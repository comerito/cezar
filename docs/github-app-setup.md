# GitHub App setup (optional)

The agent-cockpit refactor (Phase 1, §3.9 of `REFACTOR-PLAN-agent-cockpit.md`)
introduces an **optional** GitHub App that Cezar uses to mint short-lived
**installation tokens** for repo operations — currently skill discovery on
private repos, with more (bot-identity comments, labels, PRs, checks, webhooks)
arriving in later phases.

**This is additive.** Without a configured App, Cezar still works exactly as
before via per-user OAuth tokens. The App becomes a hard requirement only for
the webhook receiver in Phase 5.

## 1. Create the GitHub App

GitHub → *Settings* → *Developer settings* → *GitHub Apps* → *New GitHub App*.

- **Name:** anything (e.g. `cezar` / `<org>-cezar`).
- **Homepage URL:** your Cezar deployment URL (or a placeholder).
- **Webhook:** enable it (see [§5 below](#5-webhooks-phase-5)). If you'd rather
  skip webhooks, leave it disabled and rely on the `/api/cron/triage-sweep` poll.
- **Repository permissions** — grant the minimum needed:
  - **Contents:** Read-only (clone repos / read `.ai/skills/`)
  - **Issues:** Read & write (read issues, post triage/autofix comments)
  - **Pull requests:** Read & write (open autofix PRs)
  - **Checks:** Read-only (CI follow-up)
  - **Metadata:** Read-only (mandatory)
- **Organization permissions:** none required.
- **Where can this app be installed?** "Only on this account" is fine for a
  single team.

Create the app, then:

1. Note the **App ID** (shown on the app's settings page).
2. **Generate a private key** (bottom of the settings page) — downloads a
   `.pem` file. Keep it secret.

## 2. Install the App

On the app's settings page → *Install App* → install it on the org/user that
owns the repos Cezar will manage, and select the specific repositories (or "All
repositories").

## 3. Configure env vars

Set these wherever Cezar runs (Vercel project env, your shell, your runner):

- `GITHUB_APP_ID` — the numeric App ID.
- `GITHUB_APP_PRIVATE_KEY` — the contents of the downloaded `.pem` file. If
  your env store is single-line only, you can paste it with literal `\n`
  sequences instead of real newlines — Cezar normalizes those.
- `GITHUB_APP_WEBHOOK_SECRET` — the App's webhook secret (see [§5](#5-webhooks-phase-5)).
  Without it, `/api/github/webhook` returns **503** and you rely on the
  `/api/cron/triage-sweep` poll fallback.

When both `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are present,
`GitHubAppService.isConfigured()` returns true and Cezar prefers an installation
token for repo operations that support it (e.g. "Refresh skills from repo" in
Settings → Workflows), falling back to the per-user OAuth token if the App call
fails.

## 4. Without the App

If you don't set these env vars, nothing breaks: Cezar uses the GitHub OAuth
token from sign-in for all repo operations, exactly as before. Private-repo
skill discovery still works as long as the signed-in user can read the repo.

## 5. Webhooks (Phase 5)

The webhook receiver (`POST /api/github/webhook`) is how Cezar learns about new
issues in real time and auto-triages them.

1. On the App's settings page, enable **Webhook** and set:
   - **Webhook URL:** `https://<your-cezar>/api/github/webhook`
   - **Webhook secret:** a random string. Put the *same* value in the Cezar env
     as `GITHUB_APP_WEBHOOK_SECRET`. The receiver verifies the
     `X-Hub-Signature-256` HMAC against it; a missing secret ⇒ **503**, a bad
     signature ⇒ **401**.
2. Under *Subscribe to events*, check at minimum:
   - **Issues** — drives auto-triage (`opened` / `reopened` / title-or-body
     `edited` → enqueue a `triage` job).
   - **Pull requests** — reserved for a future webhook-driven PR↔issue link
     (currently a no-op; the `issue-match` cron handles it).
   - **Check runs** — reserved for a future webhook-driven CI follow-up
     (currently a no-op; the `ci-watch` / `ci-attribute` / `ci-fix` crons handle
     it).
   - **Installation** / **Installation repositories** — so installing the App
     records `installation_id` on the matching workspace(s).
3. The receiver does no agent work — it just upserts the issue and queues a
   `triage` job; `/api/cron/dispatch` (or a self-hosted runner) drains it.

### Poll fallback

`GET /api/cron/triage-sweep` (Vercel cron, every 10 min; same `CRON_SECRET`
auth as the other crons) finds open issues that have never been triaged and
enqueues `triage` jobs for them — the catch-up path for installs without
webhooks or missed deliveries. Tunable batch via `CEZAR_TRIAGE_SWEEP_BATCH`
(default 10 issues / workspace / tick).

### Conservative defaults

- `auto_triage_enabled` defaults **on** — new issues get triaged (classification
  + priority + a couple of derived labels + a summary comment). Toggle it in
  *Settings → Automation*.
- `autofix_enabled` defaults **off** — Cezar won't open PRs by itself until you
  flip it. When on, triage-driven autofix fires **only** on issues classified as
  `bug` whose confidence clears `autofix.minBugConfidence` (config, default 0.7),
  and the PR is **always opened as a draft**. Below the threshold, no autofix is
  queued (a triage-driven human-gate for review is a planned follow-up).
