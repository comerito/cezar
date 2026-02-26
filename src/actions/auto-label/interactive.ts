import { select, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { LabelSuggestion, LabelResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type LabelDecision = 'apply' | 'partial' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  suggestion: LabelSuggestion;
  labelsToApply: string[];
}

export class AutoLabelInteractiveUI {
  private results: LabelResults;
  private config: Config;

  constructor(results: LabelResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No label suggestions found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Auto-Label Analysis Complete'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.suggestions.length} issue(s) needing labels.`);

    const toApply: ReviewResult[] = [];
    const skipped: LabelSuggestion[] = [];
    let stopped = false;

    for (const [i, suggestion] of this.results.suggestions.entries()) {
      if (stopped) break;

      console.log(renderLabelSuggestion(suggestion, i, this.results.suggestions.length));

      let decision = await this.askDecision(suggestion);

      if (decision === 'browser') {
        openInBrowser(suggestion.htmlUrl);
        decision = await this.askDecisionAfterBrowser(suggestion);
      }

      if (decision === 'apply') {
        toApply.push({ suggestion, labelsToApply: suggestion.suggestedLabels });
      } else if (decision === 'partial') {
        const selected = await this.selectLabels(suggestion.suggestedLabels);
        if (selected.length > 0) {
          toApply.push({ suggestion, labelsToApply: selected });
        } else {
          skipped.push(suggestion);
        }
      } else if (decision === 'skip') {
        skipped.push(suggestion);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will apply labels: ${toApply.length}`);
    console.log(`  Skipped:           ${skipped.length}`);

    // Handle skips — clear suggested labels
    for (const suggestion of skipped) {
      this.results.store.setAnalysis(suggestion.number, {
        suggestedLabels: null,
        labelsReason: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toApply.length > 0) {
      const shouldApply = await confirmAction(
        `Apply labels to ${toApply.length} issue(s) on GitHub?`,
      );

      if (shouldApply) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toApply) {
            const allLabels = [...new Set([...review.suggestion.currentLabels, ...review.labelsToApply])];
            await github.setLabels(review.suggestion.number, allLabels);
            await postAuditComment(github, review.suggestion.number, [
              `Added labels: ${review.labelsToApply.map(l => `\`${l}\``).join(', ')}`,
            ]);
            this.results.store.setAnalysis(review.suggestion.number, {
              labelsAppliedAt: new Date().toISOString(),
            });
            console.log(chalk.green(`  ✓ Labels applied to #${review.suggestion.number}: ${review.labelsToApply.join(', ')}`));
          }
          await this.results.store.save();
        } catch (error) {
          console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
        }
      }
    }
  }

  private async askDecision(suggestion: LabelSuggestion): Promise<LabelDecision> {
    return select<LabelDecision>({
      message: `What do you want to do with #${suggestion.number}?`,
      choices: [
        { name: `Apply all suggested labels on GitHub`, value: 'apply' },
        { name: 'Select which labels to apply', value: 'partial' },
        { name: 'Skip — current labels are fine', value: 'skip' },
        { name: 'Open in browser to check', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(suggestion: LabelSuggestion): Promise<Exclude<LabelDecision, 'browser'>> {
    return select<Exclude<LabelDecision, 'browser'>>({
      message: `Now what do you want to do with #${suggestion.number}?`,
      choices: [
        { name: 'Apply all suggested labels', value: 'apply' },
        { name: 'Select which labels to apply', value: 'partial' },
        { name: 'Skip — current labels are fine', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async selectLabels(suggested: string[]): Promise<string[]> {
    return checkbox<string>({
      message: 'Select labels to apply:',
      choices: suggested.map(l => ({ name: l, value: l, checked: true })),
    });
  }
}

function renderLabelSuggestion(suggestion: LabelSuggestion, index: number, total: number): string {
  const lines: string[] = [];
  const header = `ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${suggestion.number}  ${suggestion.title}`);
  const current = suggestion.currentLabels.length > 0
    ? suggestion.currentLabels.map(l => chalk.dim(l)).join(', ')
    : chalk.dim('(none)');
  lines.push(`  Current labels: ${current}`);
  lines.push(`  Suggested:      ${chalk.green(suggestion.suggestedLabels.join(', '))}`);
  lines.push('');
  lines.push(`  Reason: ${suggestion.reason}`);
  lines.push('');
  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
