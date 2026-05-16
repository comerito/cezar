import chalk from 'chalk';
import type { Config } from '@cezar/core';

interface RunOptions {
  state?: string;
  recheck?: boolean;
  apply?: boolean;
  dryRun?: boolean;
  format?: string;
  interactive?: boolean;
  description?: string;
  issue?: number;
  maxIssues?: number;
  retry?: boolean;
}

/**
 * Stubbed in commit 2b2 when the legacy `@cezar/core` action-plugin tree was
 * deleted. The CLI is being rewritten on the data-driven action model in
 * commit 2b3 — until then, `cezar run <action>` reports a deprecation
 * message and exits non-zero.
 */
export async function runCommand(actionId: string, _opts: RunOptions, _config: Config): Promise<void> {
  console.error(chalk.yellow(`'cezar run ${actionId}' is being rewritten on the new data-driven action model — coming in the next release.`));
  console.error(chalk.dim('For now, use the web cockpit to launch actions.'));
  process.exit(1);
}
