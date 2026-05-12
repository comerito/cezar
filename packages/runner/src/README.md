# @cezar/runner

The Cezar **agent runner** — a long-running worker that pulls workflow jobs
(`triage` / `autofix` / `ci-followup`) from a Cezar SaaS instance over a scoped
HTTPS API, runs them locally (Anthropic API, Claude Code CLI, or Codex CLI), and
streams events back. Two modes via `--kind`:

- `cloud` — Cezar's own managed worker container; handles `anthropic-api` jobs.
- `self-hosted` — runs on a team's own infra so the subscription CLIs run under
  the team's login and code/tokens never leave the team's machine.

See `docs/REFACTOR-PLAN-agent-cockpit.md` §3.8 / Phase 4.

## Install & run

```bash
# from the monorepo root
yarn workspace @cezar/runner build

# self-hosted runner using the team's Claude Code subscription
node packages/runner/dist/cli.js login          # checks `claude` / `codex` are on PATH
node packages/runner/dist/cli.js start \
  --url https://app.example.com \
  --token <runner-token> \
  --backends claude-cli            # auto-detected if omitted on self-hosted
```

The `cezar-runner` bin is installed when the package is built/linked.

## What it needs

- **`claude` / `codex` on PATH** (and logged in) for the `claude-cli` /
  `codex-cli` backends. Run `cezar-runner login` to check; it advises which
  `<tool> login` to run. The `anthropic-api` backend needs `ANTHROPIC_API_KEY`
  in the environment instead.
- **`git`** on PATH (the runner clones repos to `~/.cezar/runner-repos`).
- A **runner token**, created on the Settings → Runners page (shown once,
  stored hashed server-side — treat like a password). *(That UI lands in Phase
  4b; until then a runner row + `token_hash` can be inserted directly into the
  `runners` table — the token is `sha256(<raw>)` hex.)*

The runner never sees a Supabase credential; the SaaS mints a short-lived GitHub
App token per job and ships it (plus the merged workspace config and the issue
store snapshot) in the claim response.

## Env vars

| Var | Purpose |
|---|---|
| `CEZAR_RUNNER_URL` / `CEZAR_RUNNER_TOKEN` | defaults for `--url` / `--token` |
| `ANTHROPIC_API_KEY` | required for the `anthropic-api` backend |
