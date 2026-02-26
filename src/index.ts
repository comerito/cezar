#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig } from './utils/config.js';
import { initCommand } from './commands/init.js';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';

const program = new Command()
  .name('issue-manager')
  .description('AI-powered GitHub issue management')
  .version('0.1.0');

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

// Default action (no subcommand) — placeholder until hub is built
program.action(async () => {
  const config = await loadConfig();
  await statusCommand(config);
});

program.parse();
