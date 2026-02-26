import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { GoodFirstIssueSuggestion, GoodFirstIssueResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type GoodFirstIssueDecision = 'label-comment' | 'label-only' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  suggestion: GoodFirstIssueSuggestion;
  postHint: boolean;
}

export class GoodFirstIssueInteractiveUI {
  private results: GoodFirstIssueResults;
  private config: Config;

  constructor(results: GoodFirstIssueResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No good first issue candidates found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Good First Issue Candidates'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.suggestions.length} issue(s) suitable for new contributors.`);

    const toApply: ReviewResult[] = [];
    const skipped: GoodFirstIssueSuggestion[] = [];
    let stopped = false;

    for (const [i, suggestion] of this.results.suggestions.entries()) {
      if (stopped) break;

      console.log(renderSuggestion(suggestion, i, this.results.suggestions.length));

      let decision = await this.askDecision(suggestion);

      if (decision === 'browser') {
        openInBrowser(suggestion.htmlUrl);
        decision = await this.askDecisionAfterBrowser(suggestion);
      }

      if (decision === 'label-comment') {
        toApply.push({ suggestion, postHint: true });
      } else if (decision === 'label-only') {
        toApply.push({ suggestion, postHint: false });
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
    const withHint = toApply.filter(r => r.postHint).length;
    const labelOnly = toApply.filter(r => !r.postHint).length;
    console.log(`  Label + hint comment: ${withHint}`);
    console.log(`  Label only:           ${labelOnly}`);
    console.log(`  Skipped:              ${skipped.length}`);

    // Handle skips — clear analysis fields
    for (const suggestion of skipped) {
      this.results.store.setAnalysis(suggestion.number, {
        isGoodFirstIssue: null,
        goodFirstIssueReason: null,
        goodFirstIssueHint: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toApply.length > 0) {
      const shouldApply = await confirmAction(
        `Add 'good first issue' label to ${toApply.length} issue(s) on GitHub?`,
      );

      if (shouldApply) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toApply) {
            await github.addLabel(review.suggestion.number, 'good first issue');

            const auditActions = [`Added \`good first issue\` label`];

            if (review.postHint) {
              const hintComment = formatHintComment(review.suggestion);
              await github.addComment(review.suggestion.number, hintComment);
              auditActions.push('Posted contributor hint comment');
            }

            await postAuditComment(github, review.suggestion.number, auditActions);

            this.results.store.setAnalysis(review.suggestion.number, {
              goodFirstIssueAnalyzedAt: new Date().toISOString(),
            });

            const status = review.postHint ? 'labeled + hint posted' : 'labeled';
            console.log(chalk.green(`  ✓ #${review.suggestion.number}: ${status}`));
          }
          await this.results.store.save();
        } catch (error) {
          console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
        }
      }
    }
  }

  private async askDecision(suggestion: GoodFirstIssueSuggestion): Promise<GoodFirstIssueDecision> {
    return select<GoodFirstIssueDecision>({
      message: `What do you want to do with #${suggestion.number}?`,
      choices: [
        { name: "Add 'good first issue' label + post hint comment", value: 'label-comment' },
        { name: "Add 'good first issue' label only", value: 'label-only' },
        { name: 'Skip — not suitable for newcomers', value: 'skip' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(suggestion: GoodFirstIssueSuggestion): Promise<Exclude<GoodFirstIssueDecision, 'browser'>> {
    return select<Exclude<GoodFirstIssueDecision, 'browser'>>({
      message: `Now what do you want to do with #${suggestion.number}?`,
      choices: [
        { name: "Add 'good first issue' label + post hint comment", value: 'label-comment' },
        { name: "Add 'good first issue' label only", value: 'label-only' },
        { name: 'Skip — not suitable for newcomers', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }
}

function renderSuggestion(suggestion: GoodFirstIssueSuggestion, index: number, total: number): string {
  const lines: string[] = [];
  const header = `ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${suggestion.number}  ${suggestion.title}`);
  lines.push(`  Complexity: ${chalk.cyan(suggestion.estimatedComplexity)}`);
  lines.push(`  Reason: ${suggestion.reason}`);
  lines.push(`  Hint: ${chalk.dim(suggestion.codeHint)}`);
  lines.push('');
  return lines.join('\n');
}

function formatHintComment(suggestion: GoodFirstIssueSuggestion): string {
  return `👋 **Good first issue** — This looks like a great issue for new contributors!\n\n**Estimated complexity:** ${suggestion.estimatedComplexity}\n\n**Where to start:** ${suggestion.codeHint}`;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
