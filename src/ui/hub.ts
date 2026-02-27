import { select, confirm, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { clearScreen, renderLogo } from './logo.js';
import { renderStatusBox } from './status.js';
import { runSetupWizard } from './setup.js';
import { actionRegistry } from '../actions/registry.js';
import type { ActionDefinition, ActionGroup } from '../actions/action.interface.js';
import { IssueStore } from '../store/store.js';
import type { Config } from '../models/config.model.js';
import { syncCommand } from '../commands/sync.js';

export async function launchHub(store: IssueStore | null, config: Config): Promise<void> {
  // First launch — run setup wizard if no store exists
  if (!store) {
    clearScreen();
    renderLogo();
    store = await runSetupWizard(config);
    if (!store) return; // wizard failed or user cancelled
  }

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

    // If action has no new work, offer to re-evaluate from scratch
    const badge = action.getBadge(store);
    const hasWork = /\d/.test(badge);

    if (!hasWork) {
      const rerun = await confirm({
        message: `${action.label} is up to date. Re-evaluate all issues from scratch?`,
        default: false,
      });
      if (!rerun) continue;
      await action.run({ store, config, interactive: true, options: { recheck: true } });
    } else {
      await action.run({ store, config, interactive: true, options: {} });
    }
  }
}

interface SelectChoice {
  name: string;
  value: string;
  disabled?: string | boolean;
}

const GROUP_ORDER: ActionGroup[] = ['triage', 'intelligence', 'release', 'community'];

function buildChoices(store: IssueStore | null): Array<SelectChoice | Separator> {
  const actions = actionRegistry.getAll();

  // Group actions by their group property
  const grouped = new Map<ActionGroup, ActionDefinition[]>();
  for (const action of actions) {
    const group = action.group;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(action);
  }

  const actionChoices: Array<SelectChoice | Separator> = [];

  for (const group of GROUP_ORDER) {
    const groupActions = grouped.get(group);
    if (!groupActions || groupActions.length === 0) continue;

    if (actionChoices.length > 0) {
      actionChoices.push(new Separator());
    }

    for (const action of groupActions) {
      if (!store) {
        actionChoices.push({
          name: formatActionChoice(action, null),
          value: action.id,
          disabled: 'Run init first',
        });
      } else {
        const availability = action.isAvailable(store);
        actionChoices.push({
          name: formatActionChoice(action, store),
          value: action.id,
          disabled: availability === true ? false : availability,
        });
      }
    }
  }

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
