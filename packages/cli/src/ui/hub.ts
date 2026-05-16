import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { clearScreen, renderLogo } from './logo.js';
import { renderStatusBox } from './status.js';
import { runSetupWizard } from './setup.js';
import { IssueStore } from '@cezar/core';
import type { Config } from '@cezar/core';
import { syncCommand } from '../commands/sync.js';

/**
 * Interactive hub — trimmed in commit 2b2 alongside the legacy action-plugin
 * deletion. Currently exposes only init/sync/exit; the action menu will be
 * rebuilt on the new data-driven model in commit 2b3.
 */
export async function launchHub(store: IssueStore | null, config: Config): Promise<void> {
  if (!store) {
    clearScreen();
    renderLogo();
    store = await runSetupWizard(config);
    if (!store) return;
  }

  const meta = store.getMeta();
  if (!config.github.owner) config.github.owner = meta.owner;
  if (!config.github.repo) config.github.repo = meta.repo;

  while (true) {
    clearScreen();
    renderLogo();
    renderStatusBox(store);
    console.log(chalk.dim('\nThe CLI action menu is being rebuilt on the data-driven action model (commit 2b3).'));
    console.log(chalk.dim('Use the web cockpit to launch actions in the meantime.\n'));

    const selected = await select({
      message: 'What would you like to do?',
      choices: [
        { name: '🔄  Sync with GitHub', value: 'sync' },
        { name: '✕   Exit', value: 'exit' },
      ],
    });

    if (selected === 'exit') return;

    if (selected === 'sync') {
      await syncCommand({}, config);
      store = await IssueStore.loadOrNull(config.store.path);
      if (!store) return;
      continue;
    }
  }
}
