import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { RecurringQuestionItem, RecurringQuestionResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { withAuditFooter } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type RecurringDecision = 'post-close' | 'post-open' | 'edit' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  item: RecurringQuestionItem;
  comment: string;
  close: boolean;
}

export class RecurringQuestionInteractiveUI {
  private results: RecurringQuestionResults;
  private config: Config;

  constructor(results: RecurringQuestionResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No recurring questions found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Recurring Question Analysis Complete'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.items.length} recurring question(s).`);

    const toPost: ReviewResult[] = [];
    const skipped: RecurringQuestionItem[] = [];
    let stopped = false;

    for (const [i, item] of this.results.items.entries()) {
      if (stopped) break;

      console.log(renderRecurringItem(item, i, this.results.items.length));

      let currentComment = item.suggestedResponse;
      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'edit') {
        currentComment = await this.editComment(currentComment);
        // After editing, ask whether to close or keep open
        const closeAfterEdit = await select<boolean>({
          message: 'Close the issue after posting?',
          choices: [
            { name: 'Yes — close as answered', value: true },
            { name: 'No — keep open', value: false },
          ],
        });
        toPost.push({ item, comment: currentComment, close: closeAfterEdit });
      } else if (decision === 'post-close') {
        toPost.push({ item, comment: currentComment, close: true });
      } else if (decision === 'post-open') {
        toPost.push({ item, comment: currentComment, close: false });
      } else if (decision === 'skip') {
        skipped.push(item);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Reset unreviewed items so they appear on the next run
    if (stopped) {
      const reviewed = new Set([
        ...toPost.map(r => r.item.number),
        ...skipped.map(s => s.number),
      ]);
      for (const item of this.results.items) {
        if (!reviewed.has(item.number)) {
          this.results.store.setAnalysis(item.number, { recurringAnalyzedAt: null });
        }
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    const toClose = toPost.filter(r => r.close).length;
    const toKeepOpen = toPost.filter(r => !r.close).length;
    console.log(`  Will post + close: ${toClose}`);
    console.log(`  Will post (open):  ${toKeepOpen}`);
    console.log(`  Skipped:           ${skipped.length}`);

    // Handle skips — clear recurring analysis fields
    for (const item of skipped) {
      this.results.store.setAnalysis(item.number, {
        isRecurringQuestion: null,
        similarClosedIssues: null,
        suggestedResponse: null,
      });
    }
    await this.results.store.save();

    // Post comments if any
    if (toPost.length > 0) {
      const action = toClose > 0 && toKeepOpen > 0
        ? `Post comments on ${toPost.length} issue(s) (${toClose} will be closed)?`
        : toClose > 0
          ? `Post comments + close ${toClose} issue(s)?`
          : `Post comments on ${toKeepOpen} issue(s)?`;

      const shouldPost = await confirmAction(action);

      if (shouldPost) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toPost) {
            const refs = review.item.similarClosedIssues.map(i => `#${i.number}`).join(', ');
            const auditActions = [
              `Identified as recurring question (similar to ${refs})`,
              ...(review.close ? ['Closed as answered'] : []),
            ];
            const commentWithAudit = withAuditFooter(review.comment, auditActions);
            await github.addComment(review.item.number, commentWithAudit);
            if (review.close) {
              await github.closeIssue(review.item.number, 'completed');
            }
            this.results.store.setAnalysis(review.item.number, {
              recurringAnalyzedAt: new Date().toISOString(),
            });
            const status = review.close ? 'posted + closed' : 'posted';
            console.log(chalk.green(`  ✓ #${review.item.number}: ${status}`));
          }
          await this.results.store.save();
        } catch (error) {
          console.error(chalk.red(`  Failed to post comments: ${(error as Error).message}`));
        }
      }
    }
  }

  private async askDecision(item: RecurringQuestionItem): Promise<RecurringDecision> {
    return select<RecurringDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: 'Post response + close issue', value: 'post-close' },
        { name: 'Post response, leave open', value: 'post-open' },
        { name: 'Edit response first', value: 'edit' },
        { name: 'Skip — not a recurring question', value: 'skip' },
        { name: 'Open in browser to compare', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: RecurringQuestionItem): Promise<Exclude<RecurringDecision, 'browser'>> {
    return select<Exclude<RecurringDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: 'Post response + close issue', value: 'post-close' },
        { name: 'Post response, leave open', value: 'post-open' },
        { name: 'Edit response first', value: 'edit' },
        { name: 'Skip — not a recurring question', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async editComment(currentComment: string): Promise<string> {
    const edited = await input({
      message: 'Edit the response (press Enter to keep as-is):',
      default: currentComment,
    });
    return edited || currentComment;
  }
}

function renderRecurringItem(item: RecurringQuestionItem, index: number, total: number): string {
  const lines: string[] = [];
  const header = `QUESTION ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  ${item.title}`);
  lines.push('');
  lines.push('  Similar closed issues:');
  for (const ref of item.similarClosedIssues) {
    lines.push(`    → #${ref.number}  ${ref.title}`);
  }
  lines.push('');
  lines.push(chalk.dim('  Suggested response:'));
  const commentLines = item.suggestedResponse.split('\n');
  for (const line of commentLines) {
    lines.push(chalk.dim(`  │ ${line}`));
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
