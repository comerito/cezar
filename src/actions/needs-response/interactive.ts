import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { NeedsResponseItem, NeedsResponseResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'label-all';
type ItemDecision = 'label' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  item: NeedsResponseItem;
  finalAction: 'label' | 'skip';
}

export class NeedsResponseInteractiveUI {
  private results: NeedsResponseResults;
  private config: Config;

  constructor(results: NeedsResponseResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No issues needing response found.');
      return;
    }

    const awaiting = this.results.needsResponse;
    const responded = this.results.items.filter(i => i.status === 'responded');
    const newIssues = awaiting.filter(i => i.status === 'new-issue');
    const needsReply = awaiting.filter(i => i.status === 'needs-response');

    // Summary screen
    console.log('');
    console.log(chalk.bold('Needs Response — Issues Awaiting Maintainer Reply'));
    console.log('='.repeat(55));
    console.log('');
    console.log(`  Total analyzed: ${this.results.items.length}`);
    if (newIssues.length > 0) console.log(`  New issues (no comments):    ${newIssues.length}`);
    if (needsReply.length > 0) console.log(`  Awaiting response:           ${needsReply.length}`);
    if (responded.length > 0) console.log(`  Already responded:           ${responded.length}`);
    console.log('');

    if (awaiting.length === 0) {
      console.log(chalk.green('All issues have been responded to!'));
      return;
    }

    const initialDecision = await select<InitialDecision>({
      message: `How do you want to review ${awaiting.length} issue(s) needing response?`,
      choices: [
        { name: 'Review one by one', value: 'review' },
        { name: "Add 'needs-response' label to all", value: 'label-all' },
      ],
    });

    let toApply: ReviewResult[];

    if (initialDecision === 'label-all') {
      toApply = awaiting.map(item => ({ item, finalAction: 'label' as const }));
    } else {
      toApply = await this.reviewItems(awaiting);

      // Reset unreviewed items (stopped early) so they appear on the next run
      const reviewedNumbers = new Set(toApply.map(r => r.item.number));
      for (const item of awaiting) {
        if (!reviewedNumbers.has(item.number)) {
          this.results.store.setAnalysis(item.number, { needsResponseAnalyzedAt: null });
        }
      }
    }

    // Summary
    const labels = toApply.filter(r => r.finalAction === 'label');
    const skips = toApply.filter(r => r.finalAction === 'skip');

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('-'.repeat(55));
    console.log(`  Will label 'needs-response': ${labels.length}`);
    console.log(`  Skipped:                     ${skips.length}`);

    // Clear analysis for skipped items
    for (const r of skips) {
      this.results.store.setAnalysis(r.item.number, {
        needsResponseStatus: null,
        needsResponseReason: null,
      });
    }
    await this.results.store.save();

    // Apply actions
    const actionable = toApply.filter(r => r.finalAction === 'label');
    if (actionable.length > 0) {
      await this.applyActions(actionable);
    }
  }

  private async reviewItems(items: NeedsResponseItem[]): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let stopped = false;

    for (const [i, item] of items.entries()) {
      if (stopped) break;

      console.log(renderItem(item, i, items.length));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'label') {
        results.push({ item, finalAction: 'label' });
      } else if (decision === 'skip') {
        results.push({ item, finalAction: 'skip' });
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    return results;
  }

  private async askDecision(item: NeedsResponseItem): Promise<ItemDecision> {
    return select<ItemDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: "Add 'needs-response' label", value: 'label' },
        { name: 'Skip', value: 'skip' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: NeedsResponseItem): Promise<Exclude<ItemDecision, 'browser'>> {
    return select<Exclude<ItemDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: "Add 'needs-response' label", value: 'label' },
        { name: 'Skip', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async applyActions(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Add 'needs-response' label to ${toApply.length} issue(s) on GitHub?`,
    );

    if (!shouldApply) return;

    try {
      const github = new GitHubService(this.config);

      for (const review of toApply) {
        const { item } = review;
        await github.addLabel(item.number, 'needs-response');
        console.log(chalk.green(`  + #${item.number}: labeled 'needs-response'`));
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to apply actions: ${(error as Error).message}`));
    }
  }
}

function renderItem(
  item: NeedsResponseItem,
  index: number,
  total: number,
): string {
  const lines: string[] = [];
  const tag = item.status === 'new-issue' ? 'NEW ISSUE' : 'NEEDS RESPONSE';
  const header = `${tag} ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  "${item.title}"`);
  lines.push(`  Status: ${item.status === 'new-issue' ? chalk.yellow('new issue') : chalk.red('needs response')}`);
  lines.push(`  Reason: ${item.reason}`);
  lines.push('');

  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
