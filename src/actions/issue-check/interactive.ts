import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { IssueCheckResults, IssueCheckMatch } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { contentHash } from '../../utils/hash.js';
import { execFile } from 'node:child_process';

type MatchDecision = 'browser' | 'create' | 'done';

export class IssueCheckInteractiveUI {
  private results: IssueCheckResults;
  private config: Config;

  constructor(results: IssueCheckResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.message) {
      console.log(this.results.message);
      return;
    }

    if (this.results.isEmpty) {
      console.log('');
      console.log(chalk.bold('No Matching Issues Found'));
      console.log('─'.repeat(55));
      await this.offerCreate();
      return;
    }

    console.log('');
    console.log(chalk.bold('Potential Matches Found'));
    console.log('─'.repeat(55));
    console.log(`Found ${this.results.matches.length} similar issue(s):\n`);

    for (const [i, match] of this.results.matches.entries()) {
      this.renderMatch(match, i);
    }

    // Per-match browser option
    for (const match of this.results.matches) {
      const decision = await select<MatchDecision>({
        message: `#${match.issue.number} (${Math.round(match.confidence * 100)}%) — ${match.issue.title}`,
        choices: [
          { name: 'Continue', value: 'done' },
          { name: 'Open in browser', value: 'browser' },
        ],
      });

      if (decision === 'browser') {
        openInBrowser(match.issue.htmlUrl);
      }
    }

    // Ask if they still want to create
    const stillCreate = await confirmAction(
      'Similar issues found. Still want to create a new issue?',
      false,
    );

    if (stillCreate) {
      await this.offerCreate();
    }
  }

  private renderMatch(match: IssueCheckMatch, index: number): void {
    const confidence = Math.round(match.confidence * 100);
    const color = confidence >= 90 ? chalk.red : confidence >= 75 ? chalk.yellow : chalk.cyan;
    console.log(`  ${index + 1}. ${color(`#${match.issue.number}`)} (${color(`${confidence}%`)}) — ${match.issue.title}`);
    console.log(`     ${chalk.dim(match.reason)}`);
    console.log(`     ${chalk.dim(match.issue.htmlUrl)}`);
    console.log('');
  }

  private async offerCreate(): Promise<void> {
    const shouldCreate = await confirmAction('Create a new issue on GitHub?');
    if (!shouldCreate) return;

    // Pre-fill title from first line if short enough
    const firstLine = this.results.description.split('\n')[0].trim();
    const defaultTitle = firstLine.length > 0 && firstLine.length <= 100 ? firstLine : '';

    const title = await input({
      message: 'Issue title:',
      default: defaultTitle || undefined,
      validate: (v) => v.trim().length > 0 || 'Title is required',
    });

    const body = this.results.description;

    const confirmed = await confirmAction(
      `Create issue "${title}" on GitHub?`,
    );

    if (!confirmed) return;

    try {
      const github = new GitHubService(this.config);
      const created = await github.createIssue(title, body);
      console.log(chalk.green(`  Created issue #${created.number}: ${created.htmlUrl}`));

      // Upsert into local store
      this.results.store.upsertIssue({
        number: created.number,
        title,
        body,
        state: 'open',
        labels: [],
        assignees: [],
        author: 'me',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        htmlUrl: created.htmlUrl,
        contentHash: contentHash(title, body),
        commentCount: 0,
        reactions: 0,
      });
      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to create issue: ${(error as Error).message}`));
    }
  }
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
