import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { CategorizeSuggestion, CategorizeResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

const CATEGORY_LABELS: Record<string, string> = {
  framework: 'framework',
  domain: 'domain',
  integration: 'integration',
};

const CATEGORY_ICONS: Record<string, string> = {
  framework: '🏗️',
  domain: '🎯',
  integration: '🔌',
};

type CategorizeDecision = 'apply' | 'change' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  suggestion: CategorizeSuggestion;
  labelToApply: string;
}

export class CategorizeInteractiveUI {
  private results: CategorizeResults;
  private config: Config;

  constructor(results: CategorizeResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No categorization suggestions found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Feature Categorization Complete'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.suggestions.length} issue(s) to categorize.`);

    const toApply: ReviewResult[] = [];
    const skipped: CategorizeSuggestion[] = [];
    let stopped = false;

    for (const [i, suggestion] of this.results.suggestions.entries()) {
      if (stopped) break;

      console.log(renderSuggestion(suggestion, i, this.results.suggestions.length));

      let decision = await this.askDecision(suggestion);

      if (decision === 'browser') {
        openInBrowser(suggestion.htmlUrl);
        decision = await this.askDecisionAfterBrowser(suggestion);
      }

      if (decision === 'apply') {
        toApply.push({ suggestion, labelToApply: CATEGORY_LABELS[suggestion.category] });
      } else if (decision === 'change') {
        const newCategory = await this.selectCategory(suggestion.category);
        toApply.push({ suggestion, labelToApply: CATEGORY_LABELS[newCategory] });
      } else if (decision === 'skip') {
        skipped.push(suggestion);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Reset unreviewed items so they appear on the next run
    if (stopped) {
      const reviewed = new Set([
        ...toApply.map(r => r.suggestion.number),
        ...skipped.map(s => s.number),
      ]);
      for (const suggestion of this.results.suggestions) {
        if (!reviewed.has(suggestion.number)) {
          this.results.store.setAnalysis(suggestion.number, {
            featureCategoryAnalyzedAt: null,
          });
        }
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will apply labels: ${toApply.length}`);
    console.log(`  Skipped:           ${skipped.length}`);

    // Handle skips — clear category
    for (const suggestion of skipped) {
      this.results.store.setAnalysis(suggestion.number, {
        featureCategory: null,
        featureCategoryReason: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toApply.length > 0) {
      const shouldApply = await confirmAction(
        `Apply category labels to ${toApply.length} issue(s) on GitHub?`,
      );

      if (shouldApply) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toApply) {
            // Remove any existing category labels, then add the new one
            const otherCategoryLabels = Object.values(CATEGORY_LABELS)
              .filter(l => l !== review.labelToApply);
            const cleanedLabels = review.suggestion.currentLabels
              .filter(l => !otherCategoryLabels.includes(l));
            const allLabels = [...new Set([...cleanedLabels, review.labelToApply])];

            await github.setLabels(review.suggestion.number, allLabels);
            await postAuditComment(github, review.suggestion.number, [
              `Categorized as \`${review.labelToApply}\``,
            ]);
            this.results.store.setAnalysis(review.suggestion.number, {
              featureCategory: review.labelToApply as 'framework' | 'domain' | 'integration',
              featureCategoryAppliedAt: new Date().toISOString(),
            });
            console.log(chalk.green(`  ✓ #${review.suggestion.number}: ${review.labelToApply}`));
          }
          await this.results.store.save();
        } catch (error) {
          console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
        }
      }
    }
  }

  private async askDecision(suggestion: CategorizeSuggestion): Promise<CategorizeDecision> {
    const icon = CATEGORY_ICONS[suggestion.category];
    return select<CategorizeDecision>({
      message: `#${suggestion.number} → ${icon} ${suggestion.category}. What do you want to do?`,
      choices: [
        { name: `Apply "${suggestion.category}" label on GitHub`, value: 'apply' },
        { name: 'Change category', value: 'change' },
        { name: 'Skip — do not label', value: 'skip' },
        { name: 'Open in browser to check', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(suggestion: CategorizeSuggestion): Promise<Exclude<CategorizeDecision, 'browser'>> {
    return select<Exclude<CategorizeDecision, 'browser'>>({
      message: `Now what do you want to do with #${suggestion.number}?`,
      choices: [
        { name: `Apply "${suggestion.category}" label`, value: 'apply' },
        { name: 'Change category', value: 'change' },
        { name: 'Skip — do not label', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async selectCategory(current: string): Promise<'framework' | 'domain' | 'integration'> {
    type Cat = 'framework' | 'domain' | 'integration';
    const all: { name: string; value: Cat }[] = [
      { name: `${CATEGORY_ICONS.framework} framework — Core framework functionality`, value: 'framework' },
      { name: `${CATEGORY_ICONS.domain} domain — Domain-specific functionality`, value: 'domain' },
      { name: `${CATEGORY_ICONS.integration} integration — External integrations`, value: 'integration' },
    ];
    return select<Cat>({
      message: 'Select the correct category:',
      choices: all.filter(c => c.value !== current),
    });
  }
}

function renderSuggestion(suggestion: CategorizeSuggestion, index: number, total: number): string {
  const lines: string[] = [];
  const header = `ISSUE ${index + 1} of ${total}`;
  const icon = CATEGORY_ICONS[suggestion.category];
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${suggestion.number}  ${suggestion.title}`);
  const current = suggestion.currentLabels.length > 0
    ? suggestion.currentLabels.map(l => chalk.dim(l)).join(', ')
    : chalk.dim('(none)');
  lines.push(`  Labels:   ${current}`);
  lines.push(`  Category: ${icon} ${chalk.green(suggestion.category)}`);
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
