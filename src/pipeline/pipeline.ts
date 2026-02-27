import chalk from 'chalk';
import type { IssueStore } from '../store/store.js';
import type { Config } from '../models/config.model.js';
import { actionRegistry } from '../actions/registry.js';
import { getCloseFlaggedIssueNumbers } from './close-flag.js';

const CLOSE_DETECTION_ACTION_IDS = ['duplicates', 'done-detector'];

export interface PipelineOptions {
  recheck?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
}

export interface PipelineResult {
  phase1Actions: string[];
  phase2Actions: string[];
  closeFlaggedCount: number;
  errors: Array<{ actionId: string; error: Error }>;
}

export async function runPipeline(
  store: IssueStore,
  config: Config,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const allActions = actionRegistry.getAll();

  const phase1 = allActions.filter(a => CLOSE_DETECTION_ACTION_IDS.includes(a.id));
  const phase2 = allActions.filter(a => !CLOSE_DETECTION_ACTION_IDS.includes(a.id));

  const result: PipelineResult = {
    phase1Actions: [],
    phase2Actions: [],
    closeFlaggedCount: 0,
    errors: [],
  };

  // --- Phase 1: Close-detection actions ---
  console.log(chalk.bold('\n── Phase 1: Close Detection ──\n'));

  for (const action of phase1) {
    const availability = action.isAvailable(store);
    if (availability !== true) {
      console.log(chalk.dim(`  Skipping ${action.label}: ${availability}`));
      continue;
    }

    console.log(chalk.cyan(`  Running ${action.icon}  ${action.label}...`));
    try {
      await action.run({
        store,
        config,
        interactive: false,
        options: {
          recheck: options.recheck ?? false,
          dryRun: options.dryRun ?? false,
        },
      });
      result.phase1Actions.push(action.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(chalk.red(`  Error in ${action.id}: ${err.message}`));
      result.errors.push({ actionId: action.id, error: err });
    }
  }

  // --- Collect close-flagged issues ---
  const excludeIssues = getCloseFlaggedIssueNumbers(store);
  result.closeFlaggedCount = excludeIssues.size;

  if (excludeIssues.size > 0) {
    console.log(chalk.yellow(`\n  ${excludeIssues.size} issue(s) flagged for closing — excluded from enrichment.\n`));
  }

  // --- Phase 2: Enrichment actions ---
  console.log(chalk.bold('\n── Phase 2: Enrichment ──\n'));

  for (const action of phase2) {
    const availability = action.isAvailable(store);
    if (availability !== true) {
      console.log(chalk.dim(`  Skipping ${action.label}: ${availability}`));
      continue;
    }

    console.log(chalk.cyan(`  Running ${action.icon}  ${action.label}...`));
    try {
      await action.run({
        store,
        config,
        interactive: false,
        options: {
          recheck: options.recheck ?? false,
          dryRun: options.dryRun ?? false,
          excludeIssues,
        },
      });
      result.phase2Actions.push(action.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(chalk.red(`  Error in ${action.id}: ${err.message}`));
      result.errors.push({ actionId: action.id, error: err });
    }
  }

  // --- Summary ---
  console.log(chalk.bold('\n── Pipeline Summary ──\n'));
  console.log(`  Phase 1: ${result.phase1Actions.length} action(s) ran`);
  console.log(`  Phase 2: ${result.phase2Actions.length} action(s) ran`);
  console.log(`  Close-flagged: ${result.closeFlaggedCount} issue(s)`);
  if (result.errors.length > 0) {
    console.log(chalk.red(`  Errors: ${result.errors.length}`));
    for (const { actionId, error } of result.errors) {
      console.log(chalk.red(`    - ${actionId}: ${error.message}`));
    }
  }
  console.log('');

  return result;
}
