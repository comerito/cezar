import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { DuplicateGroup, DuplicateResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { renderDuplicateGroup } from '../../ui/components/table.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type ReviewDecision = 'store' | 'store-label' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  group: DuplicateGroup;
  decision: ReviewDecision;
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

      const decision = await select<ReviewDecision>({
        message: `What do you want to do with #${group.duplicate.number}?`,
        choices: [
          { name: 'Mark as duplicate in store only (no GitHub change)', value: 'store' },
          { name: "Mark as duplicate + add 'duplicate' label on GitHub", value: 'store-label' },
          { name: 'Skip — not a duplicate', value: 'skip' },
          { name: 'Open both in browser to compare', value: 'browser' },
          { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
        ],
      });

      if (decision === 'browser') {
        openInBrowser(group.original.htmlUrl);
        openInBrowser(group.duplicate.htmlUrl);
        // Re-ask after opening browser
        const retry = await select<ReviewDecision>({
          message: `Now what do you want to do with #${group.duplicate.number}?`,
          choices: [
            { name: 'Mark as duplicate in store only', value: 'store' },
            { name: "Mark as duplicate + add 'duplicate' label", value: 'store-label' },
            { name: 'Skip — not a duplicate', value: 'skip' },
          ],
        });
        reviews.push({ group, decision: retry });
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

    // Summary
    const confirmed = reviews.filter(r => r.decision === 'store' || r.decision === 'store-label');
    const toLabel = reviews.filter(r => r.decision === 'store-label');
    const skipped = reviews.filter(r => r.decision === 'skip');

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Confirmed duplicates: ${confirmed.length}`);
    console.log(`  Skipped:             ${skipped.length}`);

    // Handle skips — clear the duplicate analysis for skipped items
    for (const review of skipped) {
      this.results.store.setAnalysis(review.group.duplicate.number, {
        duplicateOf: null,
        duplicateConfidence: null,
        duplicateReason: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toLabel.length > 0) {
      const shouldApply = await confirmAction(
        `Apply 'duplicate' labels to ${toLabel.length} issue(s) on GitHub?`,
      );

      if (shouldApply) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toLabel) {
            const { duplicate, original } = review.group;
            await github.addLabel(duplicate.number, 'duplicate');
            await postAuditComment(github, duplicate.number, [
              `Marked as duplicate of #${original.number} (${Math.round(review.group.confidence * 100)}% confidence)`,
              `Added \`duplicate\` label`,
            ]);
            console.log(chalk.green(`  ✓ Label + audit comment applied to #${duplicate.number}`));
          }
        } catch (error) {
          console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
        }
      }
    }
  }
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
