#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig } from './utils/config.js';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';
import { runCommand } from './commands/run.js';
import { launchHub } from './ui/hub.js';
import { IssueStore } from './store/store.js';
import { VERSION } from './utils/version.js';
import { runPipeline } from './pipeline/index.js';

// Register all actions (side-effect imports)
import './actions/duplicates/index.js';
import './actions/missing-info/index.js';
import './actions/auto-label/index.js';
import './actions/recurring-questions/index.js';
import './actions/priority/index.js';
import './actions/good-first-issue/index.js';
import './actions/security/index.js';
import './actions/release-notes/index.js';
import './actions/milestone-planner/index.js';
import './actions/stale/index.js';
import './actions/contributor-welcome/index.js';
import './actions/quality/index.js';
import './actions/done-detector/index.js';
import './actions/claim-detector/index.js';
import './actions/needs-response/index.js';
import './actions/issue-check/index.js';
import './actions/categorize/index.js';
import './actions/bug-detector/index.js';
import './actions/autofix/index.js';

const program = new Command()
  .name('cezar')
  .description('AI-powered GitHub issue management')
  .version(VERSION);

program.command('init')
  .description('Fetch all issues and generate digests')
  .option('-o, --owner <owner>', 'GitHub repository owner')
  .option('-r, --repo <repo>', 'GitHub repository name')
  .option('-t, --token <token>', 'GitHub token')
  .option('--include-closed', 'Include closed issues')
  .option('--no-digest', 'Skip LLM digest generation')
  .option('--force', 'Reinitialize even if store exists')
  .action(async (opts) => {
    const config = await loadConfig({
      github: {
        owner: opts.owner ?? '',
        repo: opts.repo ?? '',
        token: opts.token ?? '',
      },
    });
    await initCommand(opts, config);
  });

program.command('sync')
  .description('Pull new/updated issues from GitHub')
  .option('-t, --token <token>', 'GitHub token')
  .option('--include-closed', 'Include closed issues')
  .action(async (opts) => {
    const config = await loadConfig();
    await syncCommand(opts, config);
  });

program.command('status')
  .description('Show store summary')
  .action(async () => {
    const config = await loadConfig();
    await statusCommand(config);
  });

program.command('run <action>')
  .description('Run an analysis action')
  .option('--state <state>', 'open|closed|all', 'open')
  .option('--recheck', 'Re-analyze already-analyzed issues')
  .option('--apply', 'Apply results to GitHub immediately')
  .option('--dry-run', 'Show what would happen without writing')
  .option('--format <format>', 'table|json|markdown', 'table')
  .option('--no-interactive', 'Force non-interactive mode')
  .option('--description <text>', 'Issue description (for issue-check action)')
  .option('--issue <n>', 'Target a single issue number (for autofix)', v => parseInt(v, 10))
  .option('--max-issues <n>', 'Limit how many issues to process (for autofix)', v => parseInt(v, 10))
  .option('--retry', 'Reset attempt counter before running (autofix): lets a previously-exhausted issue be re-tried')
  .action(async (actionId, opts) => {
    const config = await loadConfig();
    await runCommand(actionId, opts, config);
  });

program.command('pipeline')
  .description('Run full pipeline: close-detection, enrichment, optional autofix')
  .option('--recheck', 'Re-analyze already-analyzed issues')
  .option('--dry-run', 'Show what would happen without writing')
  .option('--no-interactive', 'Force non-interactive mode')
  .option('--autofix', 'Include Phase 3 (autofix) — opens draft PRs for detected bugs')
  .option('--apply', 'Required alongside --autofix to actually push branches and open PRs')
  .option('--max-issues <n>', 'Limit autofix to N issues this run', v => parseInt(v, 10))
  .action(async (opts) => {
    const config = await loadConfig();
    const store = await IssueStore.loadOrNull(config.store.path);
    if (!store) {
      console.error(chalk.red("Store not found. Run 'cezar init' first."));
      process.exit(1);
    }
    await runPipeline(store, config, {
      recheck: opts.recheck ?? false,
      dryRun: opts.dryRun ?? false,
      interactive: opts.interactive !== false && process.stdout.isTTY === true,
      autofix: opts.autofix === true,
      apply: opts.apply === true,
      maxIssues: typeof opts.maxIssues === 'number' ? opts.maxIssues : undefined,
    });
  });

// No subcommand → launch interactive hub
program.action(async () => {
  try {
    const config = await loadConfig();
    const store = await IssueStore.loadOrNull(config.store.path);
    await launchHub(store, config);
  } catch (error) {
    if ((error as Error).name === 'ExitPromptError') {
      // User cancelled with Ctrl+C
      process.exit(0);
    }
    throw error;
  }
});

program.parseAsync().catch((error) => {
  console.error(chalk.red((error as Error).message));
  process.exit(1);
});
