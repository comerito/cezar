# Cezar

**Cezar brings order to chaotic GitHub backlogs.** Sync issues locally, let Claude analyze them, then triage through a clean interactive CLI. Find duplicates first — more actions coming. Built for maintainers who'd rather ship than sort.

```
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
- **Interactive by default, scriptable by flag** — a friendly TUI for humans, `--no-interactive` for CI.
- **Plugin architecture** — every analysis action is a self-contained module. Adding a new one means creating a folder.
- **Incremental** — `sync` only fetches what changed. Actions only process unanalyzed issues.

## Requirements

- Node.js 20+
- A [GitHub token](https://github.com/settings/tokens) (classic or fine-grained with `repo` read access)
- An [Anthropic API key](https://console.anthropic.com/)

## Installation

```bash
# Clone and install
git clone https://github.com/comerito/cezar.git
cd cezar
npm install
npm run build
npm link
```

## Quick Start

```bash
# Set your tokens (or create a .env file — see .env.example)
cp .env.example .env
# Edit .env with your real tokens

# Initialize — fetches all issues and generates AI digests
cezar init -o your-org -r your-repo

# Launch the interactive hub
cezar
```

## Commands

### `cezar init`

Fetches all issues from a GitHub repo, stores them locally, and generates AI digests for each.

```bash
cezar init -o <owner> -r <repo> [options]
```

| Flag | Description |
|------|-------------|
| `-o, --owner` | GitHub repository owner |
| `-r, --repo` | GitHub repository name |
| `-t, --token` | GitHub token (or set `GITHUB_TOKEN`) |
| `--include-closed` | Include closed issues |
| `--no-digest` | Skip AI digest generation |
| `--force` | Reinitialize even if a store already exists |

### `cezar sync`

Pulls new and updated issues since the last sync. Only re-digests issues whose content changed.

```bash
cezar sync [options]
```

| Flag | Description |
|------|-------------|
| `-t, --token` | GitHub token override |
| `--include-closed` | Include closed issues |

### `cezar status`

Prints a summary of the local store — issue counts, digest coverage, analysis state.

### `cezar run <action>`

Runs an analysis action in non-interactive mode. Currently available: `duplicates`.

```bash
cezar run duplicates [options]
```

| Flag | Description |
|------|-------------|
| `--state <state>` | Filter by `open`, `closed`, or `all` (default: `open`) |
| `--recheck` | Re-analyze already-analyzed issues |
| `--apply` | Apply results to GitHub immediately |
| `--dry-run` | Preview changes without writing |
| `--format <fmt>` | Output as `table`, `json`, or `markdown` |
| `--no-interactive` | Skip all prompts (CI mode) |

### `cezar` (no arguments)

Launches the interactive hub — a menu-driven interface with dynamic badges showing pending work.

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

## How It Works

Cezar operates in three phases:

1. **Fetch** — `init` or `sync` pulls issues from the GitHub API into a local JSON store (`.issue-store/store.json`).
2. **Digest** — Claude generates a compact summary for each issue (~80 tokens), including category, affected area, and keywords.
3. **Analyze** — Actions like duplicate detection run against the digests, not raw issue bodies. This makes analysis fast and token-efficient.

### Duplicate Detection

The duplicate finder sends compact digests to Claude in batches. With 200 issues, the full knowledge base fits in ~16k tokens — a single API call. Results are persisted per-batch, so even if the process is interrupted, partial progress is saved.

In interactive mode, each duplicate group is presented for review:

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

### CI Usage

Every command works without a TTY:

```bash
# In a GitHub Actions workflow
cezar sync
cezar run duplicates --apply --no-interactive --format json > duplicates.json
```

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
