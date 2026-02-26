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
  lines.push(`  ${chalk.green('ORIGINAL')}   #${group.original.number}  ${group.original.title}`);
  lines.push(`  ${chalk.yellow('DUPLICATE')}  #${group.duplicate.number}  ${group.duplicate.title}`);
  lines.push('');
  lines.push(`  Confidence: ${Math.round(group.confidence * 100)}%`);
  lines.push(`  Reason: ${group.reason}`);
  lines.push('');
  return lines.join('\n');
}
