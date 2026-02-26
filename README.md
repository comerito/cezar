# Cezar

**Cezar brings order to chaotic GitHub backlogs.** Sync issues locally, let Claude analyze them, then triage through a clean interactive CLI. Find duplicates first — more actions coming. Built for maintainers who'd rather ship than sort.

```
   ·  ██████╗  ███████╗ ███████╗  █████╗  ██████╗  ·
   · ██╔════╝  ██╔════╝ ╚══███╔╝ ██╔══██╗ ██╔══██╗ ·
   · ██║       █████╗     ███╔╝  ███████║ ██████╔╝ ·
   · ██║       ██╔══╝    ███╔╝   ██╔══██║ ██╔══██╗ ·
   · ╚██████╗  ███████╗ ███████╗ ██║  ██║ ██║  ██║ ·
   ·  ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ·
           AI-powered GitHub issue management

┌──────────────────────────────────────────────────┐
│  🗂  Cezar   your-org/your-repo                    │
│  143 open · 45 closed · synced 2 hours ago        │
│  Digested: 143/143 · Duplicates: last run 1d ago  │
└──────────────────────────────────────────────────┘

? What would you like to do?
❯ 🔍  Find Duplicates            45 unanalyzed
  🔄  Sync with GitHub
  ──────────────────────────────
  ✕   Exit
```

## Why Cezar?

- **Offline-first** — issues live in a local JSON store after the initial fetch. No repeated API calls.
- **AI-powered digests** — Claude generates compact summaries so duplicate detection works on meaning, not keywords.
- **Interactive by default** — a guided TUI handles everything: setup, sync, analysis, and review.
- **Plugin architecture** — every analysis action is a self-contained module. Adding a new one means creating a folder.
- **Incremental** — sync only fetches what changed. Actions only process unanalyzed issues.

## Requirements

- Node.js 20+
- A [GitHub token](https://github.com/settings/tokens) (classic or fine-grained with `repo` read access)
- An [Anthropic API key](https://console.anthropic.com/)

## Installation

```bash
git clone https://github.com/comerito/cezar.git
cd cezar
npm install
npm run build
npm link
```

## Quick Start

```bash
# Set your tokens
cp .env.example .env
# Edit .env with your real tokens

# Launch Cezar
cezar
```

That's it. On first launch Cezar walks you through a setup wizard — enter your org and repo, and it handles the rest: fetching issues, generating AI digests, and dropping you into the interactive hub.

```
  Welcome! Let's connect to your GitHub repo.

? GitHub owner (org or username): your-org
? Repository name: your-repo
? Include closed issues? No

✔ Fetched 143 issues from your-org/your-repo
  143 issues stored
✔ Digested 143/143 issues
  Categories: 71 bugs · 38 features · 14 docs · 20 others

  Setup complete!
```

From the hub you can sync with GitHub, run duplicate detection, and review results — all without leaving the app.

## How It Works

Cezar operates in three phases, all driven from the interactive hub:

1. **Fetch** — on setup (or when you choose "Sync with GitHub"), Cezar pulls issues from the GitHub API into a local JSON store.
2. **Digest** — Claude generates a compact summary for each issue (~80 tokens), including category, affected area, and keywords. A progress bar tracks batch processing in real time.
3. **Analyze** — actions like duplicate detection run against the digests, not raw issue bodies. This makes analysis fast and token-efficient.

### Duplicate Detection

Choose "Find Duplicates" from the hub. Cezar sends compact digests to Claude in batches — with 200 issues, the full knowledge base fits in ~16k tokens. Results are persisted per-batch, so even if interrupted, partial progress is saved.

Each duplicate group is presented for interactive review:

```
GROUP 1 of 8 ──────────────────────────────────────────

  ORIGINAL   #12   Login page crashes on Safari iOS
  DUPLICATE  #89   App broken on iPhone — can't log in

  Confidence: 94%
  Reason: Both describe Safari iOS login failure; #89 adds no new info.

? What do you want to do with #89?
❯ Mark as duplicate in store only (no GitHub change)
  Mark as duplicate + add 'duplicate' label on GitHub
  Skip — not a duplicate
  Open both in browser to compare
  Stop reviewing (keep decisions so far)
```

## Configuration

Cezar uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) for configuration. Create any of these files in your project root:

- `.issuemanagerrc.json`
- `.issuemanagerrc.yaml`
- `issuemanager.config.js`

Example `.issuemanagerrc.json`:

```json
{
  "github": {
    "owner": "your-org",
    "repo": "your-repo"
  },
  "llm": {
    "model": "claude-sonnet-4-20250514",
    "maxTokens": 4096
  },
  "store": {
    "path": ".issue-store"
  },
  "sync": {
    "digestBatchSize": 20,
    "duplicateBatchSize": 30,
    "minDuplicateConfidence": 0.80,
    "includeClosed": false
  }
}
```

Cezar automatically loads a `.env` file from the project root. You can also export `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` in your shell — environment variables override config file values.

## CI / Scripting

For automated pipelines, Cezar exposes direct commands that bypass the interactive UI:

```bash
cezar init -o <owner> -r <repo>          # Bootstrap without the wizard
cezar sync                                # Incremental fetch
cezar run duplicates --apply --no-interactive --format json > duplicates.json
```

See `cezar --help` for the full flag reference.

## Project Structure

```
src/
├── index.ts                      # CLI entry point (Commander setup)
├── commands/                     # init, sync, status, run
├── store/
│   ├── store.model.ts            # Zod schemas — all types derive from here
│   └── store.ts                  # IssueStore class — all data access
├── services/
│   ├── github.service.ts         # Octokit wrapper
│   └── llm.service.ts            # Anthropic SDK wrapper
├── actions/
│   ├── action.interface.ts       # Plugin contract
│   ├── registry.ts               # Plugin registry singleton
│   └── duplicates/               # First action (self-contained)
│       ├── prompt.ts             # LLM prompt template
│       ├── runner.ts             # Detection logic
│       ├── interactive.ts        # Interactive review UI
│       └── index.ts              # Registers the action
├── ui/
│   ├── hub.ts                    # Interactive menu
│   ├── setup.ts                  # First-run setup wizard
│   ├── status.ts                 # Status box renderer
│   └── components/               # Reusable UI primitives
└── utils/                        # Config, hashing, chunking, formatting
```

## Roadmap

Cezar is built around a plugin architecture. Future actions planned:

- **Priority** — assign critical/high/medium/low to each issue
- **Stale** — find abandoned issues with no recent activity
- **Cluster** — group issues by topic
- **Suggest** — draft a response for each issue

Each action is a self-contained folder in `src/actions/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add one.

## License

[MIT](LICENSE) &copy; [Comerito](https://github.com/comerito)
