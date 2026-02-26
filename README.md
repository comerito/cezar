# Cezar

**Cezar brings order to chaotic GitHub backlogs.** Sync issues locally, let Claude analyze them, then triage through a clean interactive CLI. 14 built-in actions cover duplicates, priorities, stale issues, security, labeling, and more. Built for maintainers who'd rather ship than sort.

```
   ·  ██████╗  ███████╗ ███████╗  █████╗  ██████╗  ·
   · ██╔════╝  ██╔════╝ ╚══███╔╝ ██╔══██╗ ██╔══██╗ ·
   · ██║       █████╗     ███╔╝  ███████║ ██████╔╝ ·
   · ██║       ██╔══╝    ███╔╝   ██╔══██║ ██╔══██╗ ·
   · ╚██████╗  ███████╗ ███████╗ ██║  ██║ ██║  ██║ ·
   ·  ╚═════╝  ╚══════╝ ╚══════╝ ╚═╝  ╚═╝ ╚═╝  ╚═╝ ·
           AI-powered GitHub issue management

┌──────────────────────────────────────────────────┐
│  🗂  Cezar   your-org/your-repo                  │
│  143 open · 45 closed · synced 2 hours ago       │
│  Digested: 143/143                               │
└──────────────────────────────────────────────────┘

? What would you like to do?

  Triage
❯ 🔍  Find Duplicates            45 unanalyzed
  🏷️  Auto-Label Issues           32 unanalyzed
  ❓  Request Missing Info        18 unanalyzed
  🔁  Recurring Questions         12 unanalyzed
  🧹  Stale Issue Cleanup          9 stale
  ✅  Done Detector                5 unchecked

  Intelligence
  📊  Priority Score              45 unscored
  🔒  Security Triage             45 unchecked

  Community
  🌱  Good First Issues           45 unchecked
  👋  Welcome New Contributors     3 pending
  🙋  Claim Detector              45 unchecked
  🔎  Issue Quality Check         45 unchecked

  Release
  📋  Release Notes
  🗺️  Milestone Planner
```

## Why Cezar?

- **Offline-first** — issues live in a local JSON store after the initial fetch. No repeated API calls.
- **AI-powered digests** — Claude generates compact summaries so analysis works on meaning, not keywords.
- **Interactive by default** — a guided TUI handles everything: setup, sync, analysis, and review.
- **Plugin architecture** — every analysis action is a self-contained module. Adding a new one means creating a folder.
- **Incremental** — sync only fetches what changed. Actions only process unanalyzed issues.
- **CI-ready** — every action works non-interactively with `--no-interactive`, `--apply`, and `--dry-run` flags.

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

From the hub you can sync with GitHub, run any action, and review results — all without leaving the app.

## Actions

Cezar ships with 14 analysis actions organized into four groups:

### Triage

| Action | Description | Powered by |
|---|---|---|
| 🔍 **Find Duplicates** | Detect issues describing the same problem | Claude AI |
| 🏷️ **Auto-Label Issues** | Suggest and apply labels based on issue content | Claude AI |
| ❓ **Request Missing Info** | Detect bug reports missing critical info and draft follow-up comments | Claude AI |
| 🔁 **Recurring Questions** | Find questions already answered in closed issues | Claude AI |
| 🧹 **Stale Issue Cleanup** | Review and resolve issues with no recent activity | Claude AI |
| ✅ **Done Detector** | Find open issues likely resolved by merged PRs | Claude AI |

### Intelligence

| Action | Description | Powered by |
|---|---|---|
| 📊 **Priority Score** | Assign critical/high/medium/low based on impact signals | Claude AI |
| 🔒 **Security Triage** | Scan issues for potential security implications | Claude AI |

### Community

| Action | Description | Powered by |
|---|---|---|
| 🌱 **Good First Issues** | Tag issues suitable for new contributors with hints | Claude AI |
| 👋 **Welcome New Contributors** | Post personalized welcome comments to first-time contributors | Claude AI |
| 🙋 **Claim Detector** | Find issues claimed by contributors in comments | Regex patterns |
| 🔎 **Issue Quality Check** | Flag spam, vague, and low-quality submissions | Claude AI |

### Release

| Action | Description | Powered by |
|---|---|---|
| 📋 **Release Notes** | Generate structured release notes from closed issues | Claude AI |
| 🗺️ **Milestone Planner** | Group open issues into logical release milestones | Claude AI |

Every action follows the same interactive review pattern: analyze, present results with a summary, then let you review one-by-one (or bulk-accept/skip). If you stop partway through, unreviewed items are saved for the next run.

## How It Works

Cezar operates in three phases, all driven from the interactive hub:

1. **Fetch** — on setup (or when you choose "Sync with GitHub"), Cezar pulls issues from the GitHub API into a local JSON store.
2. **Digest** — Claude generates a compact summary for each issue (~80 tokens), including category, affected area, and keywords.
3. **Analyze** — actions run against the digests (or directly against GitHub data for non-AI actions like Claim Detector). Results are persisted per-batch, so even if interrupted, partial progress is saved.

### Example: Duplicate Detection

Choose "Find Duplicates" from the hub. Cezar sends compact digests to Claude in batches — with 200 issues, the full knowledge base fits in ~16k tokens.

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
cezar run duplicates --no-interactive     # Run any action non-interactively
cezar run priority --apply --format json  # Apply results + JSON output
cezar run stale --dry-run                 # Preview without writing
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
│   ├── llm.service.ts            # Anthropic SDK wrapper
│   └── audit.ts                  # Audit comment formatting
├── actions/
│   ├── action.interface.ts       # Plugin contract
│   ├── registry.ts               # Plugin registry singleton
│   ├── duplicates/               # Each action is self-contained:
│   ├── auto-label/               #   prompt.ts  — LLM prompt template
│   ├── missing-info/             #   runner.ts  — detection logic
│   ├── recurring-questions/      #   interactive.ts — review UI
│   ├── stale/                    #   index.ts   — registers the action
│   ├── done-detector/
│   ├── priority/
│   ├── security/
│   ├── good-first-issue/
│   ├── contributor-welcome/
│   ├── claim-detector/
│   ├── quality/
│   ├── release-notes/
│   └── milestone-planner/
├── ui/
│   ├── hub.ts                    # Interactive menu
│   ├── setup.ts                  # First-run setup wizard
│   ├── status.ts                 # Status box renderer
│   └── components/               # Reusable UI primitives
└── utils/                        # Config, hashing, chunking, formatting
```

## Adding a New Action

Each action is a self-contained folder in `src/actions/`. To create one:

1. Create `src/actions/your-action/` with `prompt.ts`, `runner.ts`, `interactive.ts`, `index.ts`
2. Add your analysis fields to `src/store/store.model.ts`
3. Add a side-effect import to `src/index.ts`

See any existing action folder for the full pattern.

## License

[MIT](LICENSE) &copy; [Comerito](https://github.com/comerito)
