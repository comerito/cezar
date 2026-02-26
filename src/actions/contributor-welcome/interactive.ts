import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { WelcomeCandidate, WelcomeResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { withAuditFooter } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'post-all' | 'skip-all';
type WelcomeDecision = 'post' | 'edit' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  candidate: WelcomeCandidate;
}

export class ContributorWelcomeInteractiveUI {
  private results: WelcomeResults;
  private config: Config;

  constructor(results: WelcomeResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No first-time contributors to welcome.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Welcome New Contributors'));
    console.log('═'.repeat(55));
    console.log('');
    console.log(`  Found ${this.results.candidates.length} first-time contributor(s) to welcome:`);
    console.log('');

    for (const c of this.results.candidates) {
      console.log(`  #${c.number}  @${chalk.cyan(c.author)}  [${c.category}]  ${c.title}`);
    }
    console.log('');

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to proceed?',
      choices: [
        { name: 'Review each message before posting', value: 'review' },
        { name: 'Post all welcome messages', value: 'post-all' },
        { name: 'Skip all — no action needed', value: 'skip-all' },
      ],
    });

    if (initialDecision === 'skip-all') {
      console.log(chalk.dim('  All skipped.'));
      return;
    }

    let toApply: ReviewResult[];

    if (initialDecision === 'post-all') {
      toApply = this.results.candidates.map(c => ({ candidate: c }));
    } else {
      toApply = await this.reviewCandidates();
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will post welcome: ${toApply.length}`);
    console.log(`  Skipped:           ${this.results.candidates.length - toApply.length}`);

    if (toApply.length > 0) {
      await this.postWelcomes(toApply);
    }
  }

  private async reviewCandidates(): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let stopped = false;

    for (const [i, candidate] of this.results.candidates.entries()) {
      if (stopped) break;

      console.log(renderCandidate(candidate, i, this.results.candidates.length));

      let decision = await this.askDecision(candidate);

      if (decision === 'browser') {
        openInBrowser(candidate.htmlUrl);
        decision = await this.askDecisionAfterBrowser(candidate);
      }

      if (decision === 'post') {
        results.push({ candidate });
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    return results;
  }

  private async askDecision(candidate: WelcomeCandidate): Promise<WelcomeDecision> {
    return select<WelcomeDecision>({
      message: `What do you want to do with #${candidate.number}?`,
      choices: [
        { name: 'Post welcome comment', value: 'post' },
        { name: 'Skip — don\'t welcome', value: 'skip' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(candidate: WelcomeCandidate): Promise<Exclude<WelcomeDecision, 'browser'>> {
    return select<Exclude<WelcomeDecision, 'browser'>>({
      message: `Now what do you want to do with #${candidate.number}?`,
      choices: [
        { name: 'Post welcome comment', value: 'post' },
        { name: 'Skip — don\'t welcome', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async postWelcomes(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Post welcome comments on ${toApply.length} issue(s)?`,
    );

    if (!shouldApply) return;

    try {
      const github = new GitHubService(this.config);

      for (const review of toApply) {
        const { candidate } = review;

        const comment = withAuditFooter(candidate.welcomeMessage, [
          `Welcomed first-time contributor @${candidate.author}`,
        ]);
        await github.addComment(candidate.number, comment);

        this.results.store.setAnalysis(candidate.number, {
          welcomeCommentPostedAt: new Date().toISOString(),
        });

        console.log(chalk.green(`  ✓ #${candidate.number}: welcomed @${candidate.author}`));
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to post welcomes: ${(error as Error).message}`));
    }
  }
}

function renderCandidate(candidate: WelcomeCandidate, index: number, total: number): string {
  const lines: string[] = [];
  const header = `CONTRIBUTOR ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${candidate.number}  ${candidate.title}`);
  lines.push(`  Author: @${chalk.cyan(candidate.author)}  Category: ${candidate.category}`);
  lines.push('');
  lines.push('  Draft welcome message:');
  lines.push(chalk.dim(`  ┌${'─'.repeat(50)}┐`));
  for (const line of candidate.welcomeMessage.split('\n')) {
    lines.push(chalk.dim(`  │ ${line.padEnd(49)}│`));
  }
  lines.push(chalk.dim(`  └${'─'.repeat(50)}┘`));
  lines.push('');
  return lines.join('\n');
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
