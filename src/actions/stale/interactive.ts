import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { StaleIssueResult, StaleResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { withAuditFooter } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'accept-all' | 'review-closes';
type StaleDecision = 'close' | 'label-stale' | 'keep' | 'edit' | 'browser' | 'stop';

interface ReviewResult {
  item: StaleIssueResult;
  finalAction: 'close' | 'label-stale' | 'keep';
}

const ACTION_COLORS: Record<string, (s: string) => string> = {
  'close-resolved': chalk.green,
  'close-wontfix': chalk.yellow,
  'label-stale': chalk.cyan,
  'keep-open': chalk.dim,
};

export class StaleInteractiveUI {
  private results: StaleResults;
  private config: Config;

  constructor(results: StaleResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No stale issues found.');
      return;
    }

    // Summary screen
    console.log('');
    console.log(chalk.bold('Stale Issue Cleanup'));
    console.log('═'.repeat(55));
    console.log('');
    console.log(`  Found ${this.results.items.length} stale issue(s) (no activity for ${this.config.sync.staleDaysThreshold}+ days)`);
    console.log('');

    const counts = this.results.actionCounts;
    console.log('  Suggested actions:');
    if (counts['close-resolved']) console.log(`    Close as resolved:  ${counts['close-resolved']}`);
    if (counts['close-wontfix']) console.log(`    Close as won't fix: ${counts['close-wontfix']}`);
    if (counts['label-stale']) console.log(`    Add 'stale' label:  ${counts['label-stale']}`);
    if (counts['keep-open']) console.log(`    Keep open:          ${counts['keep-open']}`);
    console.log('');

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to review?',
      choices: [
        { name: 'Review one by one', value: 'review' },
        { name: 'Accept all suggestions', value: 'accept-all' },
        { name: 'Only review close suggestions', value: 'review-closes' },
      ],
    });

    let toApply: ReviewResult[];

    if (initialDecision === 'accept-all') {
      toApply = this.results.items.map(item => ({
        item,
        finalAction: item.action === 'keep-open' ? 'keep' as const : item.action === 'label-stale' ? 'label-stale' as const : 'close' as const,
      }));
    } else {
      const reviewItems = initialDecision === 'review-closes'
        ? this.results.items.filter(i => i.action === 'close-resolved' || i.action === 'close-wontfix')
        : this.results.items;

      toApply = await this.reviewItems(reviewItems);

      // Reset unreviewed items (stopped early) so they appear on the next run
      const reviewedNumbers = new Set(toApply.map(r => r.item.number));
      for (const item of reviewItems) {
        if (!reviewedNumbers.has(item.number)) {
          this.results.store.setAnalysis(item.number, { staleAnalyzedAt: null });
        }
      }

      // For review-closes mode, auto-accept non-close items
      if (initialDecision === 'review-closes') {
        const nonCloseItems = this.results.items.filter(
          i => i.action !== 'close-resolved' && i.action !== 'close-wontfix',
        );
        for (const item of nonCloseItems) {
          toApply.push({
            item,
            finalAction: item.action === 'label-stale' ? 'label-stale' : 'keep',
          });
        }
      }
    }

    // Summary
    const closes = toApply.filter(r => r.finalAction === 'close');
    const labels = toApply.filter(r => r.finalAction === 'label-stale');
    const keeps = toApply.filter(r => r.finalAction === 'keep');

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will close:       ${closes.length}`);
    console.log(`  Will label stale: ${labels.length}`);
    console.log(`  Keep open:        ${keeps.length}`);

    // Clear stale analysis for kept items
    for (const r of keeps) {
      this.results.store.setAnalysis(r.item.number, {
        staleAction: null,
        staleReason: null,
        staleDraftComment: null,
      });
    }
    await this.results.store.save();

    // Apply actions
    const actionable = toApply.filter(r => r.finalAction !== 'keep');
    if (actionable.length > 0) {
      await this.applyActions(actionable);
    }
  }

  private async reviewItems(items: StaleIssueResult[]): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let stopped = false;

    for (const [i, item] of items.entries()) {
      if (stopped) break;

      console.log(renderStaleIssue(item, i, items.length, this.config.sync.staleCloseDays));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'close') {
        results.push({ item, finalAction: 'close' });
      } else if (decision === 'label-stale') {
        results.push({ item, finalAction: 'label-stale' });
      } else if (decision === 'keep') {
        results.push({ item, finalAction: 'keep' });
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    return results;
  }

  private async askDecision(item: StaleIssueResult): Promise<StaleDecision> {
    return select<StaleDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: 'Close with comment', value: 'close' },
        { name: `Add 'stale' label + warning (will close in ${this.config.sync.staleCloseDays} days)`, value: 'label-stale' },
        { name: 'Keep open — still relevant', value: 'keep' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: StaleIssueResult): Promise<Exclude<StaleDecision, 'browser'>> {
    return select<Exclude<StaleDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: 'Close with comment', value: 'close' },
        { name: `Add 'stale' label + warning (will close in ${this.config.sync.staleCloseDays} days)`, value: 'label-stale' },
        { name: 'Keep open — still relevant', value: 'keep' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async applyActions(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Apply actions to ${toApply.length} issue(s) on GitHub?`,
    );

    if (!shouldApply) return;

    try {
      const github = new GitHubService(this.config);

      for (const review of toApply) {
        const { item, finalAction } = review;

        if (finalAction === 'close') {
          const reason = item.action === 'close-resolved' ? 'completed' as const : 'not_planned' as const;

          if (item.draftComment) {
            const comment = withAuditFooter(item.draftComment, [
              `Closed as ${item.action.replace('close-', '')}`,
              `Inactive for ${item.daysSinceUpdate} days`,
            ]);
            await github.addComment(item.number, comment);
          }

          await github.closeIssue(item.number, reason);
          console.log(chalk.green(`  ✓ #${item.number}: closed (${item.action})`));

        } else if (finalAction === 'label-stale') {
          const warningComment = withAuditFooter(
            item.draftComment || `This issue has been inactive for ${item.daysSinceUpdate} days. Is it still relevant? If there's no response within ${this.config.sync.staleCloseDays} days, it will be closed automatically.`,
            [`Added \`stale\` label`, `Inactive for ${item.daysSinceUpdate} days`],
          );
          await github.addLabel(item.number, 'stale');
          await github.addComment(item.number, warningComment);
          console.log(chalk.cyan(`  ✓ #${item.number}: labeled stale`));
        }
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to apply actions: ${(error as Error).message}`));
    }
  }
}

function renderStaleIssue(
  item: StaleIssueResult,
  index: number,
  total: number,
  staleCloseDays: number,
): string {
  const lines: string[] = [];
  const header = `STALE ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  "${item.title}" — ${item.daysSinceUpdate} days inactive`);

  const color = ACTION_COLORS[item.action] ?? chalk.dim;
  lines.push(`  Suggested: ${color(item.action)}`);
  lines.push(`  Reason: ${item.reason}`);

  if (item.draftComment) {
    lines.push('');
    lines.push('  Draft comment:');
    lines.push(chalk.dim(`  ┌${'─'.repeat(50)}┐`));
    for (const line of item.draftComment.split('\n')) {
      lines.push(chalk.dim(`  │ ${line.padEnd(49)}│`));
    }
    lines.push(chalk.dim(`  └${'─'.repeat(50)}┘`));
  }

  lines.push('');
  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
