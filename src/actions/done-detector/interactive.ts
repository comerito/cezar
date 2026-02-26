import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { DoneIssueResult, DoneDetectorResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { withAuditFooter } from '../../services/audit.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'accept-all' | 'skip-all';
type DoneDecision = 'close' | 'label' | 'keep' | 'browser' | 'stop';

interface ReviewResult {
  item: DoneIssueResult;
  finalAction: 'close' | 'label' | 'keep';
}

export class DoneDetectorInteractiveUI {
  private results: DoneDetectorResults;
  private config: Config;

  constructor(results: DoneDetectorResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No issues with merged PR references found.');
      return;
    }

    const resolved = this.results.resolved;

    // Summary screen
    console.log('');
    console.log(chalk.bold('Done Detector — Likely Resolved Issues'));
    console.log('═'.repeat(55));
    console.log('');
    console.log(`  Checked: ${this.results.items.length} issue(s) with merged PR references`);
    console.log(`  Likely resolved: ${resolved.length}`);
    console.log(`  Not resolved: ${this.results.items.length - resolved.length}`);
    console.log('');

    if (resolved.length > 0) {
      console.log('  Resolved issues:');
      for (const item of resolved) {
        const prs = item.mergedPRs.map(pr => `#${pr.prNumber}`).join(', ');
        console.log(`    #${item.number} [${(item.confidence * 100).toFixed(0)}%] ${item.title}`);
        console.log(`      PRs: ${prs}`);
      }
      console.log('');
    }

    if (resolved.length === 0) {
      console.log('  No issues detected as resolved. Nothing to do.');
      return;
    }

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to review resolved issues?',
      choices: [
        { name: 'Review one by one', value: 'review' },
        { name: 'Accept all (close all as completed)', value: 'accept-all' },
        { name: 'Skip all (keep open)', value: 'skip-all' },
      ],
    });

    let toApply: ReviewResult[];

    if (initialDecision === 'skip-all') {
      return;
    } else if (initialDecision === 'accept-all') {
      toApply = resolved.map(item => ({ item, finalAction: 'close' as const }));
    } else {
      toApply = await this.reviewItems(resolved);

      // Reset unreviewed items (stopped early) so they appear on the next run
      const reviewedNumbers = new Set(toApply.map(r => r.item.number));
      for (const item of resolved) {
        if (!reviewedNumbers.has(item.number)) {
          this.results.store.setAnalysis(item.number, { doneAnalyzedAt: null });
        }
      }
    }

    // Summary
    const closes = toApply.filter(r => r.finalAction === 'close');
    const labels = toApply.filter(r => r.finalAction === 'label');
    const keeps = toApply.filter(r => r.finalAction === 'keep');

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will close as completed: ${closes.length}`);
    console.log(`  Will add 'resolved' label: ${labels.length}`);
    console.log(`  Keep open: ${keeps.length}`);

    // Apply actions
    const actionable = toApply.filter(r => r.finalAction !== 'keep');
    if (actionable.length > 0) {
      await this.applyActions(actionable);
    }
  }

  private async reviewItems(items: DoneIssueResult[]): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let stopped = false;

    for (const [i, item] of items.entries()) {
      if (stopped) break;

      console.log(renderDoneIssue(item, i, items.length));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'close') {
        results.push({ item, finalAction: 'close' });
      } else if (decision === 'label') {
        results.push({ item, finalAction: 'label' });
      } else if (decision === 'keep') {
        results.push({ item, finalAction: 'keep' });
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    return results;
  }

  private async askDecision(item: DoneIssueResult): Promise<DoneDecision> {
    return select<DoneDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: 'Close as completed', value: 'close' },
        { name: "Add 'resolved' label (softer triage)", value: 'label' },
        { name: 'Keep open — not actually resolved', value: 'keep' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: DoneIssueResult): Promise<Exclude<DoneDecision, 'browser'>> {
    return select<Exclude<DoneDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: 'Close as completed', value: 'close' },
        { name: "Add 'resolved' label (softer triage)", value: 'label' },
        { name: 'Keep open — not actually resolved', value: 'keep' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private async applyActions(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Apply actions to ${toApply.length} issue(s) on GitHub?`,
    );

    if (!shouldApply) return;

    try {
      const github = new GitHubService(this.config);

      for (const review of toApply) {
        const { item, finalAction } = review;
        const prs = item.mergedPRs.map(pr => `#${pr.prNumber}`).join(', ');

        if (finalAction === 'close') {
          const comment = withAuditFooter(
            item.draftComment || `This issue appears to have been resolved by ${prs}.`,
            [`Closed as completed`, `Resolving PR(s): ${prs}`],
          );
          await github.addComment(item.number, comment);
          await github.closeIssue(item.number, 'completed');
          console.log(chalk.green(`  ✓ #${item.number}: closed as completed (${prs})`));

        } else if (finalAction === 'label') {
          await github.addLabel(item.number, 'resolved');
          await postAuditComment(github, item.number, [
            `Added \`resolved\` label`,
            `Merged PR(s): ${prs}`,
          ]);
          console.log(chalk.cyan(`  ✓ #${item.number}: labeled 'resolved' (${prs})`));
        }
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to apply actions: ${(error as Error).message}`));
    }
  }
}

function renderDoneIssue(
  item: DoneIssueResult,
  index: number,
  total: number,
): string {
  const lines: string[] = [];
  const header = `RESOLVED ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  "${item.title}"`);
  lines.push(`  Confidence: ${chalk.green(`${(item.confidence * 100).toFixed(0)}%`)}`);
  lines.push(`  Reason: ${item.reason}`);

  const prs = item.mergedPRs.map(pr => `#${pr.prNumber} — ${pr.prTitle}`);
  lines.push('');
  lines.push('  Merged PRs:');
  for (const pr of prs) {
    lines.push(`    ${pr}`);
  }

  if (item.draftComment) {
    lines.push('');
    lines.push('  Draft comment:');
    lines.push(chalk.dim(`  ┌${'─'.repeat(50)}┐`));
    for (const line of item.draftComment.split('\n')) {
      lines.push(chalk.dim(`  │ ${line.padEnd(49)}│`));
    }
    lines.push(chalk.dim(`  └${'─'.repeat(50)}┘`));
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
