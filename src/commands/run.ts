import chalk from 'chalk';
import type { Config } from '../models/config.model.js';
import { IssueStore } from '../store/store.js';
import { actionRegistry } from '../actions/registry.js';

interface RunOptions {
  state?: string;
  recheck?: boolean;
  apply?: boolean;
  dryRun?: boolean;
  format?: string;
  interactive?: boolean;
  description?: string;
}

export async function runCommand(actionId: string, opts: RunOptions, config: Config): Promise<void> {
  const store = await IssueStore.loadOrNull(config.store.path);
  if (!store) {
    console.error(chalk.red("Store not found. Run 'cezar init' first."));
    process.exit(1);
  }

  const action = actionRegistry.get(actionId);
  if (!action) {
    const available = actionRegistry.getAll().map(a => a.id).join(', ');
    console.error(chalk.red(`Unknown action '${actionId}'. Available: ${available || 'none'}`));
    process.exit(1);
  }

  const availability = action.isAvailable(store);
  if (availability !== true) {
    console.error(chalk.red(`Cannot run '${actionId}': ${availability}`));
    process.exit(1);
  }

  const interactive = opts.interactive !== false && process.stdout.isTTY === true;

  await action.run({
    store,
    config,
    interactive,
    options: {
      state: opts.state ?? 'open',
      recheck: opts.recheck ?? false,
      apply: opts.apply ?? false,
      dryRun: opts.dryRun ?? false,
      format: opts.format ?? 'table',
      description: opts.description,
    },
  });
}
