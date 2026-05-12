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
- **Webhook:** leave **disabled** for now (webhooks land in Phase 5; you'll set
  a `GITHUB_APP_WEBHOOK_SECRET` then).
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
- `GITHUB_APP_WEBHOOK_SECRET` — **not used yet**; reserved for the Phase 5
  webhook receiver.

When both `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are present,
`GitHubAppService.isConfigured()` returns true and Cezar prefers an installation
token for repo operations that support it (e.g. "Refresh skills from repo" in
Settings → Workflows), falling back to the per-user OAuth token if the App call
fails.

## 4. Without the App

If you don't set these env vars, nothing breaks: Cezar uses the GitHub OAuth
token from sign-in for all repo operations, exactly as before. Private-repo
skill discovery still works as long as the signed-in user can read the repo.
