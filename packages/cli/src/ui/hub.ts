import { select, confirm, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import { clearScreen, renderLogo } from './logo.js';
import { renderStatusBox } from './status.js';
import { runSetupWizard } from './setup.js';
import { actionRegistry } from '@cezar/core';
import type { ActionDefinition, ActionGroup } from '@cezar/core';
import { IssueStore } from '@cezar/core';
import type { Config } from '@cezar/core';
import { syncCommand } from '../commands/sync.js';
import { runPipeline } from '../pipeline.js';

export async function launchHub(store: IssueStore | null, config: Config): Promise<void> {
  // First launch — run setup wizard if no store exists
  if (!store) {
    clearScreen();
    renderLogo();
    store = await runSetupWizard(config);
    if (!store) return; // wizard failed or user cancelled
  }

  // Populate config from store metadata (owner/repo may not be in config file)
  const meta = store.getMeta();
  if (!config.github.owner) config.github.owner = meta.owner;
  if (!config.github.repo) config.github.repo = meta.repo;

  while (true) {
    clearScreen();
    renderLogo();
    renderStatusBox(store);

    const { choices, hiddenCount } = buildChoices(store, config);
    if (hiddenCount > 0) {
      console.log(
        chalk.dim(`  ${hiddenCount} experimental actions hidden — set \`experimental: true\` in your config to show them.\n`),
      );
    }

    const selected = await select({
      message: 'What would you like to do?',
      choices,
      pageSize: 10,
    });

    if (selected === 'exit') return;

    if (selected === 'pipeline') {
      if (!store) {
        console.error(chalk.red("Store not found. Run 'cezar init' first."));
        continue;
      }
      await runPipeline(store, config);
      // Reload store after pipeline to pick up new data
      store = await IssueStore.loadOrNull(config.store.path);
      continue;
    }

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

// Genuinely-orphaned actions: hidden from the hub unless `config.experimental`.
// They stay registered (CLI `run <id>` + GUI unaffected) — see Phase 6 / the
// audit notes. `issue-check` targets issue authors not maintainers; `release-notes`
// output goes nowhere; `milestone-planner` doesn't apply milestones; `needs-response`
// is a list with no escalation.
const EXPERIMENTAL_ACTION_IDS = new Set(['issue-check', 'release-notes', 'milestone-planner', 'needs-response']);

function buildChoices(
  store: IssueStore | null,
  config: Config,
): { choices: Array<SelectChoice | Separator>; hiddenCount: number } {
  const showExperimental = config.experimental === true;
  let hiddenCount = 0;
  const actions = actionRegistry.getAll().filter((a) => {
    if (showExperimental || !EXPERIMENTAL_ACTION_IDS.has(a.id)) return true;
    hiddenCount++;
    return false;
  });

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

  return {
    choices: [
      ...actionChoices,
      new Separator(),
      { name: '🚀  Run Full Pipeline', value: 'pipeline' },
      { name: '🔄  Sync with GitHub', value: 'sync' },
      new Separator(),
      { name: '✕   Exit', value: 'exit' },
    ],
    hiddenCount,
  };
}

function formatActionChoice(action: ActionDefinition, store: IssueStore | null): string {
  const badge = store ? action.getBadge(store) : '';
  const padding = ' '.repeat(Math.max(0, 30 - action.label.length));
  return `${action.icon}  ${action.label}${padding}${badge ? chalk.dim(badge) : ''}`;
}
