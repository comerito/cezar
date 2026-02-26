import Table from 'cli-table3';
import chalk from 'chalk';
import type { StoredIssue } from '../store/store.model.js';
import type { DuplicateGroup } from '../actions/duplicates/runner.js';

export type OutputFormat = 'table' | 'json' | 'markdown';

export function formatIssueTable(issues: StoredIssue[], format: OutputFormat = 'table'): string {
  if (format === 'json') {
    return JSON.stringify(issues.map(i => ({
      number: i.number,
      title: i.title,
      state: i.state,
      category: i.digest?.category ?? null,
      labels: i.labels,
    })), null, 2);
  }

  if (format === 'markdown') {
    const lines = ['| # | Title | State | Category | Labels |', '|---|-------|-------|----------|--------|'];
    for (const issue of issues) {
      lines.push(`| ${issue.number} | ${issue.title} | ${issue.state} | ${issue.digest?.category ?? '—'} | ${issue.labels.join(', ') || '—'} |`);
    }
    return lines.join('\n');
  }

  // table format
  const isTTY = process.stdout.isTTY;
  if (!isTTY) {
    // Plain text for non-TTY
    return issues.map(i =>
      `#${i.number}\t${i.title}\t${i.state}\t${i.digest?.category ?? '—'}`
    ).join('\n');
  }

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

export function formatDuplicateReport(groups: DuplicateGroup[], format: OutputFormat = 'table'): string {
  if (format === 'json') {
    return JSON.stringify(groups.map(g => ({
      duplicate: g.duplicate.number,
      original: g.original.number,
      confidence: g.confidence,
      reason: g.reason,
    })), null, 2);
  }

  if (format === 'markdown') {
    const lines = ['| Duplicate | Original | Confidence | Reason |', '|-----------|----------|------------|--------|'];
    for (const g of groups) {
      lines.push(`| #${g.duplicate.number} | #${g.original.number} | ${Math.round(g.confidence * 100)}% | ${g.reason} |`);
    }
    return lines.join('\n');
  }

  // table format
  const isTTY = process.stdout.isTTY;
  if (!isTTY) {
    return groups.map(g =>
      `#${g.duplicate.number} → #${g.original.number}\t${Math.round(g.confidence * 100)}%\t${g.reason}`
    ).join('\n');
  }

  const table = new Table({
    head: [
      chalk.bold('Duplicate'),
      chalk.bold('Original'),
      chalk.bold('Confidence'),
      chalk.bold('Reason'),
    ],
    colWidths: [12, 12, 14, 50],
    wordWrap: true,
  });

  for (const g of groups) {
    table.push([
      `#${g.duplicate.number}`,
      `#${g.original.number}`,
      `${Math.round(g.confidence * 100)}%`,
      g.reason,
    ]);
  }

  return table.toString();
}

export function formatSyncSummary(created: number, updated: number, unchanged: number): string {
  const parts = [];
  if (created > 0) parts.push(`${created} new`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);
  return parts.join(', ') || 'no changes';
}
