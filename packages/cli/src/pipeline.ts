import ora from 'ora';
import chalk from 'chalk';
import {
  runPipeline as runCorePipeline,
  type IssueStore,
  type Config,
  type PipelineOptions,
  type PipelineResult,
} from '@cezar/core';

/**
 * Terminal wrapper around the headless pipeline. Prints lifecycle events via
 * an ora spinner and formats the final summary.
 */
export async function runPipeline(
  store: IssueStore,
  config: Config,
  options: Omit<PipelineOptions, 'events'> = {},
): Promise<PipelineResult> {
  const spinner = ora().start();

  const result = await runCorePipeline(store, config, {
    ...options,
    events: {
      lifecycle(message) {
        // Phase headers print as permanent lines; step progress updates the spinner.
        if (message.startsWith('── ')) {
          spinner.clear();
          process.stdout.write(`\n${chalk.bold(message)}\n\n`);
          spinner.render();
        } else {
          spinner.text = message;
        }
      },
      agent() {},
    },
  });

  spinner.stop();

  console.log('\n── Pipeline Summary ──\n');
  console.log(`  Phase 1: ${result.phase1Actions.length} action(s) ran`);
  console.log(`  Phase 2: ${result.phase2Actions.length} action(s) ran`);
  if (options.autofix) {
    console.log(`  Phase 3: ${result.phase3Actions.length} action(s) ran`);
  }
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
