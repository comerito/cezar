import ora, { type Ora } from 'ora';
import chalk from 'chalk';

export function createSpinner(text: string): Ora {
  return ora(text);
}

export async function withSpinner<T>(text: string, fn: (spinner: Ora) => Promise<T>): Promise<T> {
  const spinner = ora(text).start();
  try {
    const result = await fn(spinner);
    spinner.succeed();
    return result;
  } catch (error) {
    spinner.fail();
    throw error;
  }
}

const BAR_WIDTH = 30;

export function progressBar(done: number, total: number): string {
  const ratio = total > 0 ? done / total : 0;
  const filled = Math.round(BAR_WIDTH * ratio);
  const empty = BAR_WIDTH - filled;
  const bar = chalk.cyan('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
  const pct = Math.round(ratio * 100);
  return `${bar} ${done}/${total} (${pct}%)`;
}
