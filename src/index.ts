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
  .action(async (actionId, opts) => {
    const config = await loadConfig();
    await runCommand(actionId, opts, config);
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
