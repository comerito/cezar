import { select, input, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { ReleaseNotesRunner, type ReleaseNotesOptions } from './runner.js';

type SelectionMethod = 'date-range' | 'all-closed' | 'pick-issues';
type OutputDecision = 'copy' | 'save' | 'regenerate' | 'done';

export class ReleaseNotesInteractiveUI {
  private store: IssueStore;
  private config: Config;

  constructor(store: IssueStore, config: Config) {
    this.store = store;
    this.config = config;
  }

  async present(): Promise<void> {
    console.log('');
    console.log(chalk.bold('Release Notes Generator'));
    console.log('─'.repeat(55));

    const options = await this.gatherOptions();
    const runner = new ReleaseNotesRunner(this.store, this.config);

    let result = await runner.generate(options);

    if (result.isEmpty) {
      console.log(result.message ?? 'No issues found for release notes.');
      return;
    }

    let currentMarkdown = result.markdown;

    // Output loop
    let done = false;
    while (!done) {
      console.log('');
      console.log('═'.repeat(55));
      console.log(currentMarkdown);
      console.log('═'.repeat(55));

      const decision = await select<OutputDecision>({
        message: 'What next?',
        choices: [
          { name: 'Copy to clipboard', value: 'copy' },
          { name: 'Save to file', value: 'save' },
          { name: 'Regenerate', value: 'regenerate' },
          { name: 'Done', value: 'done' },
        ],
      });

      if (decision === 'copy') {
        await copyToClipboard(currentMarkdown);
      } else if (decision === 'save') {
        await this.saveToFile(currentMarkdown);
      } else if (decision === 'regenerate') {
        result = await runner.generate(options);
        if (!result.isEmpty) {
          currentMarkdown = result.markdown;
        }
      } else {
        done = true;
      }
    }
  }

  private async gatherOptions(): Promise<ReleaseNotesOptions> {
    const method = await select<SelectionMethod>({
      message: 'How do you want to select issues for this release?',
      choices: [
        { name: 'By date range', value: 'date-range' },
        { name: 'All closed issues', value: 'all-closed' },
        { name: 'Pick specific issues', value: 'pick-issues' },
      ],
    });

    const versionTag = await input({
      message: 'Version tag (optional, e.g. v2.4.0):',
    });

    const options: ReleaseNotesOptions = {};
    if (versionTag) options.versionTag = versionTag;

    if (method === 'date-range') {
      const since = await input({
        message: 'Start date (YYYY-MM-DD):',
        validate: v => /^\d{4}-\d{2}-\d{2}$/.test(v) || 'Use YYYY-MM-DD format',
      });
      const until = await input({
        message: 'End date (YYYY-MM-DD):',
        validate: v => /^\d{4}-\d{2}-\d{2}$/.test(v) || 'Use YYYY-MM-DD format',
      });
      options.since = `${since}T00:00:00Z`;
      options.until = `${until}T23:59:59Z`;
    } else if (method === 'pick-issues') {
      const closedIssues = this.store.getIssues({ state: 'closed', hasDigest: true });
      if (closedIssues.length === 0) {
        console.log(chalk.yellow('No closed issues available.'));
        return options;
      }
      const selected = await checkbox<number>({
        message: 'Select issues to include:',
        choices: closedIssues.map(i => ({
          name: `#${i.number} — ${i.title}`,
          value: i.number,
          checked: false,
        })),
      });
      options.issues = selected;
    }
    // 'all-closed' uses defaults (no filters)

    return options;
  }

  private async saveToFile(markdown: string): Promise<void> {
    const filePath = await input({
      message: 'Save to file:',
      default: 'CHANGELOG.md',
    });

    try {
      let content = markdown;
      try {
        const existing = await readFile(filePath, 'utf-8');
        // Prepend to existing file
        content = markdown + '\n' + existing;
      } catch {
        // File doesn't exist, just write
      }
      await writeFile(filePath, content, 'utf-8');
      console.log(chalk.green(`  ✓ Saved to ${filePath}`));
    } catch (error) {
      console.error(chalk.red(`  Failed to save: ${(error as Error).message}`));
    }
  }
}

async function copyToClipboard(text: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'pbcopy' : platform === 'win32' ? 'clip' : 'xclip';
  const args = platform === 'win32' ? [] : platform === 'darwin' ? [] : ['-selection', 'clipboard'];

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = execFile(cmd, args, (error) => {
        if (error) reject(error);
        else resolve();
      });
      proc.stdin?.write(text);
      proc.stdin?.end();
    });
    console.log(chalk.green('  ✓ Copied to clipboard'));
  } catch {
    console.log(chalk.yellow('  Could not copy to clipboard. The release notes are displayed above.'));
  }
}
