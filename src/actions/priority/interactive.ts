import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { PrioritizedIssue, PriorityResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'accept-all' | 'accept-apply';
type PriorityDecision = 'accept' | 'override' | 'skip' | 'browser' | 'stop';
type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';

interface ReviewResult {
  item: PrioritizedIssue;
  priority: PriorityLevel;
}

const PRIORITY_COLORS: Record<PriorityLevel, (s: string) => string> = {
  critical: chalk.red,
  high: chalk.yellow,
  medium: chalk.blue,
  low: chalk.dim,
};

const PRIORITY_BARS: Record<PriorityLevel, string> = {
  critical: '████',
  high: '███ ',
  medium: '██  ',
  low: '█   ',
};

export class PriorityInteractiveUI {
  private results: PriorityResults;
  private config: Config;

  constructor(results: PriorityResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No issues to prioritize.');
      return;
    }

    // Show ranked summary table
    console.log('');
    console.log(chalk.bold('Priority Analysis Complete'));
    console.log('─'.repeat(55));
    console.log('');

    for (const item of this.results.items) {
      const color = PRIORITY_COLORS[item.priority];
      const bar = PRIORITY_BARS[item.priority];
      console.log(`  ${color(bar)} ${color(item.priority.padEnd(9))} #${item.number}  ${item.title}`);
      console.log(`  ${' '.repeat(14)}Signals: ${chalk.dim(item.signals.join(', '))}`);
    }
    console.log('');

    const initialDecision = await select<InitialDecision>({
      message: 'Review each priority assignment?',
      choices: [
        { name: 'Yes, review one by one', value: 'review' },
        { name: 'Accept all as-is', value: 'accept-all' },
        { name: 'Accept all + apply priority labels on GitHub', value: 'accept-apply' },
      ],
    });

    if (initialDecision === 'accept-all') {
      await this.results.store.save();
      console.log(chalk.green('  ✓ All priorities accepted'));
      return;
    }

    if (initialDecision === 'accept-apply') {
      const toApply = this.results.items.map(item => ({ item, priority: item.priority }));
      await this.applyLabels(toApply);
      return;
    }

    // Review one by one
    const toApply: ReviewResult[] = [];
    const skipped: PrioritizedIssue[] = [];
    let stopped = false;

    for (const [i, item] of this.results.items.entries()) {
      if (stopped) break;

      console.log(renderPriorityItem(item, i, this.results.items.length));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'accept') {
        toApply.push({ item, priority: item.priority });
      } else if (decision === 'override') {
        const newPriority = await this.selectPriority(item.priority);
        this.results.store.setAnalysis(item.number, {
          priority: newPriority,
          priorityReason: item.reason,
        });
        toApply.push({ item, priority: newPriority });
      } else if (decision === 'skip') {
        skipped.push(item);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will apply priority: ${toApply.length}`);
    console.log(`  Skipped:             ${skipped.length}`);

    // Handle skips — clear priority fields
    for (const item of skipped) {
      this.results.store.setAnalysis(item.number, {
        priority: null,
        priorityReason: null,
        prioritySignals: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toApply.length > 0) {
      await this.applyLabels(toApply);
    }
  }

  private async applyLabels(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Apply priority labels to ${toApply.length} issue(s) on GitHub?`,
    );

    if (shouldApply) {
      try {
        const github = new GitHubService(this.config);
        for (const review of toApply) {
          const label = `priority: ${review.priority}`;
          await github.addLabel(review.item.number, label);
          await postAuditComment(github, review.item.number, [
            `Assigned priority: \`${review.priority}\``,
            `Added \`${label}\` label`,
          ]);
          console.log(chalk.green(`  ✓ #${review.item.number}: ${review.priority}`));
        }
        await this.results.store.save();
      } catch (error) {
        console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
      }
    }
  }

  private async askDecision(item: PrioritizedIssue): Promise<PriorityDecision> {
    return select<PriorityDecision>({
      message: `Accept this priority?`,
      choices: [
        { name: `Accept (${item.priority})`, value: 'accept' },
        { name: 'Override — set different priority', value: 'override' },
        { name: "Skip — don't assign priority", value: 'skip' },
        { name: 'Open in browser to check', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: PrioritizedIssue): Promise<Exclude<PriorityDecision, 'browser'>> {
    return select<Exclude<PriorityDecision, 'browser'>>({
      message: `Accept this priority?`,
      choices: [
        { name: `Accept (${item.priority})`, value: 'accept' },
        { name: 'Override — set different priority', value: 'override' },
        { name: "Skip — don't assign priority", value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async selectPriority(current: PriorityLevel): Promise<PriorityLevel> {
    return select<PriorityLevel>({
      message: `Set priority (current: ${current}):`,
      choices: [
        { name: `critical — data loss, security, production down`, value: 'critical' },
        { name: `high — regression, broken core functionality`, value: 'high' },
        { name: `medium — non-critical bug, UX issue`, value: 'medium' },
        { name: `low — enhancement, cosmetic, edge case`, value: 'low' },
      ],
    });
  }
}

function renderPriorityItem(item: PrioritizedIssue, index: number, total: number): string {
  const lines: string[] = [];
  const header = `ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  ${item.title}`);
  const color = PRIORITY_COLORS[item.priority];
  lines.push(`  AI priority: ${color(item.priority)}`);
  lines.push(`  Reason: ${item.reason}`);
  lines.push(`  Signals: ${item.signals.join(', ')}`);
  lines.push('');
  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
