import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { MissingInfoItem, MissingInfoResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { withAuditFooter } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type ReviewDecision = 'post' | 'edit' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  item: MissingInfoItem;
  comment: string;
}

export class MissingInfoInteractiveUI {
  private results: MissingInfoResults;
  private config: Config;

  constructor(results: MissingInfoResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No issues with missing information found.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Missing Information Check Complete'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.items.length} bug report(s) with missing info.`);

    const toPost: ReviewResult[] = [];
    const skipped: MissingInfoItem[] = [];
    let stopped = false;

    for (const [i, item] of this.results.items.entries()) {
      if (stopped) break;

      console.log(renderMissingInfoItem(item, i, this.results.items.length));

      let currentComment = item.suggestedComment;
      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'edit') {
        currentComment = await this.editComment(currentComment);
        toPost.push({ item, comment: currentComment });
      } else if (decision === 'post') {
        toPost.push({ item, comment: currentComment });
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
          this.results.store.setAnalysis(item.number, { missingInfoAnalyzedAt: null });
        }
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will post comments: ${toPost.length}`);
    console.log(`  Skipped:            ${skipped.length}`);

    // Handle skips — clear the missing info analysis for skipped items
    for (const item of skipped) {
      this.results.store.setAnalysis(item.number, {
        missingInfoFields: null,
        missingInfoComment: null,
      });
    }
    await this.results.store.save();

    // Post comments if any
    if (toPost.length > 0) {
      const shouldPost = await confirmAction(
        `Post comments + add 'needs-info' label on ${toPost.length} issue(s)?`,
      );

      if (shouldPost) {
        try {
          const github = new GitHubService(this.config);
          for (const review of toPost) {
            const commentWithAudit = withAuditFooter(review.comment, [
              `Requested missing information: ${review.item.missingFields.join(', ')}`,
              `Added \`needs-info\` label`,
            ]);
            await github.addComment(review.item.number, commentWithAudit);
            await github.addLabel(review.item.number, 'needs-info');
            this.results.store.setAnalysis(review.item.number, {
              missingInfoPostedAt: new Date().toISOString(),
            });
            console.log(chalk.green(`  ✓ Comment posted on #${review.item.number}`));
          }
          await this.results.store.save();
        } catch (error) {
          console.error(chalk.red(`  Failed to post comments: ${(error as Error).message}`));
        }
      }
    }
  }

  private async askDecision(item: MissingInfoItem): Promise<ReviewDecision> {
    return select<ReviewDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: "Post comment + add 'needs-info' label on GitHub", value: 'post' },
        { name: 'Edit comment before posting', value: 'edit' },
        { name: 'Skip — info is actually present', value: 'skip' },
        { name: 'Open in browser to check', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: MissingInfoItem): Promise<Exclude<ReviewDecision, 'browser'>> {
    return select<Exclude<ReviewDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: "Post comment + add 'needs-info' label", value: 'post' },
        { name: 'Edit comment before posting', value: 'edit' },
        { name: 'Skip — info is actually present', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async editComment(currentComment: string): Promise<string> {
    const edited = await input({
      message: 'Edit the comment (press Enter to keep as-is):',
      default: currentComment,
    });
    return edited || currentComment;
  }
}

function renderMissingInfoItem(item: MissingInfoItem, index: number, total: number): string {
  const lines: string[] = [];
  const header = `ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  ${item.title}`);
  lines.push(`  Missing: ${chalk.yellow(item.missingFields.join(', '))}`);
  lines.push('');
  lines.push(chalk.dim('  Suggested comment:'));
  const commentLines = item.suggestedComment.split('\n');
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
