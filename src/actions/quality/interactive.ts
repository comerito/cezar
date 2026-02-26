import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { QualityFlagged, QualityResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review-all' | 'review-spam' | 'skip-all';
type QualityDecision = 'label' | 'label-close' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  item: QualityFlagged;
  close: boolean;
}

const FLAG_COLORS: Record<string, (s: string) => string> = {
  spam: chalk.red,
  vague: chalk.yellow,
  test: chalk.magenta,
  'wrong-language': chalk.cyan,
};

const FLAG_DISPLAY: Record<string, string> = {
  spam: 'Spam',
  vague: 'Vague',
  test: 'Test/accidental',
  'wrong-language': 'Wrong language',
};

export class QualityInteractiveUI {
  private results: QualityResults;
  private config: Config;

  constructor(results: QualityResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No quality issues found.');
      return;
    }

    // Summary screen
    console.log('');
    console.log(chalk.bold('Issue Quality Check'));
    console.log('═'.repeat(55));
    console.log('');

    const counts = this.results.flagCounts;
    console.log('  Flagged:');
    for (const [flag, count] of Object.entries(counts)) {
      const color = FLAG_COLORS[flag] ?? chalk.dim;
      console.log(`    ${color(FLAG_DISPLAY[flag] ?? flag)}: ${count}`);
    }
    console.log('');

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to review?',
      choices: [
        { name: 'Review all flagged issues', value: 'review-all' },
        { name: 'Only review spam', value: 'review-spam' },
        { name: 'Skip — no action needed', value: 'skip-all' },
      ],
    });

    if (initialDecision === 'skip-all') {
      // Clear flags for all
      for (const item of this.results.flagged) {
        this.results.store.setAnalysis(item.number, {
          qualityFlag: 'ok',
          qualityReason: null,
        });
      }
      await this.results.store.save();
      console.log(chalk.dim('  All flags cleared.'));
      return;
    }

    const reviewItems = initialDecision === 'review-spam'
      ? this.results.flagged.filter(i => i.flag === 'spam')
      : this.results.flagged;

    const toApply: ReviewResult[] = [];
    const skipped: QualityFlagged[] = [];
    let stopped = false;

    for (const [i, item] of reviewItems.entries()) {
      if (stopped) break;

      console.log(renderFlaggedIssue(item, i, reviewItems.length));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'label') {
        toApply.push({ item, close: false });
      } else if (decision === 'label-close') {
        toApply.push({ item, close: true });
      } else if (decision === 'skip') {
        skipped.push(item);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Reset unreviewed items so they appear on the next run
    if (stopped) {
      const reviewed = new Set([
        ...toApply.map(r => r.item.number),
        ...skipped.map(s => s.number),
      ]);
      for (const item of reviewItems) {
        if (!reviewed.has(item.number)) {
          this.results.store.setAnalysis(item.number, { qualityAnalyzedAt: null });
        }
      }
    }

    // Summary
    const willLabel = toApply.filter(r => !r.close).length;
    const willClose = toApply.filter(r => r.close).length;

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will label:        ${willLabel}`);
    console.log(`  Will label+close:  ${willClose}`);
    console.log(`  Skipped:           ${skipped.length}`);

    // Clear flags for skipped items
    for (const item of skipped) {
      this.results.store.setAnalysis(item.number, {
        qualityFlag: 'ok',
        qualityReason: null,
      });
    }
    await this.results.store.save();

    if (toApply.length > 0) {
      await this.applyActions(toApply);
    }
  }

  private async askDecision(item: QualityFlagged): Promise<QualityDecision> {
    return select<QualityDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: `Add '${item.suggestedLabel}' label on GitHub`, value: 'label' },
        { name: `Add '${item.suggestedLabel}' label + close issue`, value: 'label-close' },
        { name: 'Skip — legitimate issue', value: 'skip' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: QualityFlagged): Promise<Exclude<QualityDecision, 'browser'>> {
    return select<Exclude<QualityDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: `Add '${item.suggestedLabel}' label on GitHub`, value: 'label' },
        { name: `Add '${item.suggestedLabel}' label + close issue`, value: 'label-close' },
        { name: 'Skip — legitimate issue', value: 'skip' },
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
        const { item, close } = review;

        await github.addLabel(item.number, item.suggestedLabel);

        const auditActions = [
          `Flagged as ${item.flag}: ${item.reason}`,
          `Added \`${item.suggestedLabel}\` label`,
        ];

        if (close) {
          await github.closeIssue(item.number, 'not_planned');
          auditActions.push('Closed issue');
        }

        await postAuditComment(github, item.number, auditActions);

        const status = close ? `labeled + closed` : `labeled '${item.suggestedLabel}'`;
        console.log(chalk.green(`  ✓ #${item.number}: ${status}`));
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to apply actions: ${(error as Error).message}`));
    }
  }
}

function renderFlaggedIssue(item: QualityFlagged, index: number, total: number): string {
  const lines: string[] = [];
  const header = `FLAGGED ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  ${item.title}`);

  const color = FLAG_COLORS[item.flag] ?? chalk.dim;
  lines.push(`  Flag: ${color(FLAG_DISPLAY[item.flag] ?? item.flag)}`);
  lines.push(`  Reason: ${item.reason}`);
  lines.push(`  Suggested label: ${chalk.dim(item.suggestedLabel)}`);
  lines.push('');
  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
