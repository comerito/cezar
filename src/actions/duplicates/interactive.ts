import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { DuplicateGroup, DuplicateResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { renderDuplicateGroup } from '../../ui/components/table.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type ReviewDecision =
  | 'close-dup'   // close duplicate, keep original
  | 'close-orig'  // swap: close original, keep duplicate
  | 'label'       // label duplicate only + link (no close)
  | 'store'       // store only
  | 'skip'        // not a duplicate
  | 'browser'     // open both
  | 'stop';       // exit

interface ReviewResult {
  group: DuplicateGroup;
  decision: Exclude<ReviewDecision, 'browser' | 'stop'>;
}

export class DuplicatesInteractiveUI {
  private results: DuplicateResults;
  private config: Config;

  constructor(results: DuplicateResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No duplicates found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Duplicate Detection Complete'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.groups.length} duplicate group(s).`);

    const reviews: ReviewResult[] = [];
    let stopped = false;

    for (const [i, group] of this.results.groups.entries()) {
      if (stopped) break;

      console.log(renderDuplicateGroup(group, i, this.results.groups.length));

      const decision = await this.askDecision(group);

      if (decision === 'browser') {
        openInBrowser(group.original.htmlUrl);
        openInBrowser(group.duplicate.htmlUrl);
        // Re-ask after opening browser
        const retry = await this.askDecision(group, true);
        if (retry === 'stop') {
          stopped = true;
        } else if (retry !== 'browser') {
          reviews.push({ group, decision: retry });
        }
      } else if (decision === 'stop') {
        stopped = true;
      } else {
        reviews.push({ group, decision });
      }
    }

    // Reset unreviewed items so they appear on the next run
    if (stopped) {
      const reviewed = new Set(reviews.map(r => r.group.duplicate.number));
      for (const group of this.results.groups) {
        if (!reviewed.has(group.duplicate.number)) {
          this.results.store.setAnalysis(group.duplicate.number, { duplicatesAnalyzedAt: null });
        }
      }
    }

    // Handle skips — clear the duplicate analysis for skipped items
    const skipped = reviews.filter(r => r.decision === 'skip');
    for (const review of skipped) {
      this.results.store.setAnalysis(review.group.duplicate.number, {
        duplicateOf: null,
        duplicateConfidence: null,
        duplicateReason: null,
      });
    }
    await this.results.store.save();

    // Partition actionable decisions
    const toClose = reviews.filter(r => r.decision === 'close-dup');
    const toSwap = reviews.filter(r => r.decision === 'close-orig');
    const toLabel = reviews.filter(r => r.decision === 'label');
    const storeOnly = reviews.filter(r => r.decision === 'store');

    // Summary
    const actionable = toClose.length + toSwap.length + toLabel.length + storeOnly.length;
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Confirmed duplicates: ${actionable}`);
    console.log(`  Skipped:             ${skipped.length}`);

    // Apply batches
    const github = (toClose.length + toSwap.length + toLabel.length) > 0
      ? new GitHubService(this.config)
      : null;

    await this.applyLabelBatch(toLabel, github!);
    await this.applyCloseBatch(toClose, github!);
    await this.applySwapBatch(toSwap, github!);
  }

  private async askDecision(group: DuplicateGroup, afterBrowser = false): Promise<ReviewDecision> {
    const dup = group.duplicate.number;
    const orig = group.original.number;
    const message = afterBrowser
      ? `Now what do you want to do with #${dup}?`
      : `What do you want to do?`;

    const choices: Array<{ name: string; value: ReviewDecision }> = [
      {
        name: `Close #${dup} as duplicate of #${orig} (label + close + link)`,
        value: 'close-dup',
      },
      {
        name: `Close #${orig} as duplicate of #${dup} (swap direction)`,
        value: 'close-orig',
      },
      {
        name: `Label #${dup} as duplicate only (+ link, no close)`,
        value: 'label',
      },
      {
        name: 'Store only (no GitHub changes)',
        value: 'store',
      },
      {
        name: 'Skip — not a duplicate',
        value: 'skip',
      },
    ];

    if (!afterBrowser) {
      choices.push({ name: 'Open both in browser', value: 'browser' });
    }

    choices.push({ name: 'Stop reviewing', value: 'stop' });

    return select<ReviewDecision>({ message, choices });
  }

  private async applyLabelBatch(reviews: ReviewResult[], github: GitHubService): Promise<void> {
    if (reviews.length === 0) return;

    const shouldApply = await confirmAction(
      `Label ${reviews.length} issue(s) as duplicate + post link comments on GitHub?`,
    );

    if (!shouldApply) return;

    try {
      for (const review of reviews) {
        const { duplicate, original } = review.group;
        const confidence = Math.round(review.group.confidence * 100);

        await github.addLabel(duplicate.number, 'duplicate');
        // Bidirectional linking comments
        await github.addComment(duplicate.number, `Duplicate of #${original.number} — linked by cezar`);
        await github.addComment(original.number, `Has duplicate: #${duplicate.number} (labeled by cezar)`);
        // Audit comment
        await postAuditComment(github, duplicate.number, [
          `Marked as duplicate of #${original.number} (${confidence}% confidence)`,
          `Added \`duplicate\` label`,
          `Cross-reference comments posted on both issues`,
        ]);

        console.log(chalk.green(`  ✓ Labeled #${duplicate.number} + linked to #${original.number}`));
      }
    } catch (error) {
      console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
    }
  }

  private async applyCloseBatch(reviews: ReviewResult[], github: GitHubService): Promise<void> {
    if (reviews.length === 0) return;

    const shouldApply = await confirmAction(
      `Close ${reviews.length} duplicate(s) on GitHub (label + close + link)?`,
    );

    if (!shouldApply) return;

    try {
      for (const review of reviews) {
        const { duplicate, original } = review.group;
        const confidence = Math.round(review.group.confidence * 100);

        await github.addLabel(duplicate.number, 'duplicate');
        // Bidirectional linking comments
        await github.addComment(duplicate.number, `Duplicate of #${original.number} — linked by cezar`);
        await github.addComment(original.number, `Has duplicate: #${duplicate.number} (closed by cezar)`);
        // Close the duplicate
        await github.closeIssue(duplicate.number, 'not_planned');
        // Update local store state
        const localIssue = this.results.store.getIssue(duplicate.number);
        if (localIssue) {
          localIssue.state = 'closed';
        }
        // Audit comment
        await postAuditComment(github, duplicate.number, [
          `Closed as duplicate of #${original.number} (${confidence}% confidence)`,
          `Added \`duplicate\` label`,
          `Cross-reference comments posted on both issues`,
        ]);

        console.log(chalk.green(`  ✓ Closed #${duplicate.number} as duplicate of #${original.number}`));
      }
      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to close duplicates: ${(error as Error).message}`));
    }
  }

  private async applySwapBatch(reviews: ReviewResult[], github: GitHubService): Promise<void> {
    if (reviews.length === 0) return;

    const shouldApply = await confirmAction(
      `Close ${reviews.length} issue(s) with swapped direction on GitHub (label + close + link)?`,
    );

    if (!shouldApply) return;

    try {
      for (const review of reviews) {
        const { duplicate, original } = review.group;
        const confidence = Math.round(review.group.confidence * 100);
        // Swap: the "original" becomes the duplicate to close,
        //       the "duplicate" becomes the one to keep
        const toClose = original;
        const toKeep = duplicate;

        // Swap store analysis: move duplicateOf from duplicate → original
        this.results.store.setAnalysis(toClose.number, {
          duplicateOf: toKeep.number,
          duplicateConfidence: review.group.confidence,
          duplicateReason: review.group.reason,
        });
        this.results.store.setAnalysis(toKeep.number, {
          duplicateOf: null,
          duplicateConfidence: null,
          duplicateReason: null,
        });

        await github.addLabel(toClose.number, 'duplicate');
        // Bidirectional linking comments
        await github.addComment(toClose.number, `Duplicate of #${toKeep.number} — linked by cezar`);
        await github.addComment(toKeep.number, `Has duplicate: #${toClose.number} (closed by cezar)`);
        // Close the swapped issue
        await github.closeIssue(toClose.number, 'not_planned');
        // Update local store state
        const localIssue = this.results.store.getIssue(toClose.number);
        if (localIssue) {
          localIssue.state = 'closed';
        }
        // Audit comment
        await postAuditComment(github, toClose.number, [
          `Closed as duplicate of #${toKeep.number} (${confidence}% confidence, direction swapped by user)`,
          `Added \`duplicate\` label`,
          `Cross-reference comments posted on both issues`,
        ]);

        console.log(chalk.green(`  ✓ Closed #${toClose.number} as duplicate of #${toKeep.number} (swapped)`));
      }
      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to close swapped duplicates: ${(error as Error).message}`));
    }
  }
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
