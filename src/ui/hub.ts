import { select, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { clearScreen, renderLogo } from './logo.js';
import { renderStatusBox } from './status.js';
import { actionRegistry } from '../actions/registry.js';
import type { ActionDefinition } from '../actions/action.interface.js';
import { IssueStore } from '../store/store.js';
import type { Config } from '../models/config.model.js';
import { syncCommand } from '../commands/sync.js';

export async function launchHub(store: IssueStore | null, config: Config): Promise<void> {
  while (true) {
    clearScreen();
    renderLogo();
    renderStatusBox(store);

    const choices = buildChoices(store);

    const selected = await select({
      message: 'What would you like to do?',
      choices,
      pageSize: 10,
    });

    if (selected === 'exit') return;

    if (selected === 'sync') {
      await syncCommand({}, config);
      // Reload store after sync to pick up new data
      store = await IssueStore.loadOrNull(config.store.path);
      continue;
    }

    // selected is an action id — look it up and run it
    if (!store) {
      console.error(chalk.red("Store not found. Run 'cezar init' first."));
      continue;
    }

    const action = actionRegistry.get(selected);
    if (!action) continue;

    await action.run({ store, config, interactive: true, options: {} });
  }
}

interface SelectChoice {
  name: string;
  value: string;
  disabled?: string | boolean;
}

function buildChoices(store: IssueStore | null): Array<SelectChoice | Separator> {
  const actions = actionRegistry.getAll();

  const actionChoices: Array<SelectChoice | Separator> = actions.map(action => {
    if (!store) {
      return {
        name: formatActionChoice(action, null),
        value: action.id,
        disabled: 'Run init first',
      };
    }

    const availability = action.isAvailable(store);
    return {
      name: formatActionChoice(action, store),
      value: action.id,
      disabled: availability === true ? false : availability,
    };
  });

  return [
    ...actionChoices,
    new Separator(),
    { name: '🔄  Sync with GitHub', value: 'sync' },
    new Separator(),
    { name: '✕   Exit', value: 'exit' },
  ];
}

function formatActionChoice(action: ActionDefinition, store: IssueStore | null): string {
  const badge = store ? action.getBadge(store) : '';
  const padding = ' '.repeat(Math.max(0, 30 - action.label.length));
  return `${action.icon}  ${action.label}${padding}${badge ? chalk.dim(badge) : ''}`;
}
