import Table from 'cli-table3';
import chalk from 'chalk';
import type { StoredIssue } from '../../store/store.model.js';
import type { DuplicateGroup } from '../../actions/duplicates/runner.js';

export function renderIssueTable(issues: StoredIssue[]): string {
  const table = new Table({
    head: [
      chalk.bold('#'),
      chalk.bold('Title'),
      chalk.bold('State'),
      chalk.bold('Category'),
      chalk.bold('Labels'),
    ],
    colWidths: [8, 50, 10, 12, 20],
    wordWrap: true,
  });

  for (const issue of issues) {
    table.push([
      issue.number.toString(),
      issue.title.slice(0, 48),
      issue.state,
      issue.digest?.category ?? '—',
      issue.labels.join(', ') || '—',
    ]);
  }

  return table.toString();
}

export function renderDuplicateGroup(group: DuplicateGroup, index: number, total: number): string {
  const lines: string[] = [];
  const header = `GROUP ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  const origState = group.original.state === 'open' ? chalk.green('open') : chalk.gray('closed');
  const dupState = group.duplicate.state === 'open' ? chalk.green('open') : chalk.gray('closed');
  lines.push(`  ${chalk.green('ORIGINAL')}   #${group.original.number} [${origState}]  ${group.original.title}`);
  lines.push(`               ${chalk.dim(group.original.htmlUrl)}`);
  lines.push(`  ${chalk.yellow('DUPLICATE')}  #${group.duplicate.number} [${dupState}]  ${group.duplicate.title}`);
  lines.push(`               ${chalk.dim(group.duplicate.htmlUrl)}`);
  lines.push('');
  lines.push(`  Confidence: ${Math.round(group.confidence * 100)}%`);
  lines.push(`  Reason: ${group.reason}`);
  lines.push('');
  return lines.join('\n');
}
