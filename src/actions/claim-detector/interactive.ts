import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { ClaimIssueResult, ClaimDetectorResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'assign-all' | 'skip-all';
type ClaimDecision = 'assign' | 'assign-label' | 'keep' | 'browser' | 'stop';

interface ReviewResult {
  item: ClaimIssueResult;
  finalAction: 'assign' | 'assign-label' | 'keep';
}

export class ClaimDetectorInteractiveUI {
  private results: ClaimDetectorResults;
  private config: Config;

  constructor(results: ClaimDetectorResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No claim comments detected.');
      return;
    }

    const claimed = this.results.claimed;

    // Summary screen
    console.log('');
    console.log(chalk.bold('Claim Detector — Issues with Contributor Claims'));
    console.log('═'.repeat(55));
    console.log('');
    console.log(`  Found: ${claimed.length} issue(s) with claim comments`);
    console.log('');

    for (const item of claimed) {
      console.log(`    #${item.number}  ${item.title}`);
      console.log(`      @${item.claimant}: "${item.snippet}"`);
    }
    console.log('');

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to review claimed issues?',
      choices: [
        { name: 'Review one by one', value: 'review' },
        { name: 'Assign all contributors', value: 'assign-all' },
        { name: 'Skip all (keep unassigned)', value: 'skip-all' },
      ],
    });

    let toApply: ReviewResult[];

    if (initialDecision === 'skip-all') {
      return;
    } else if (initialDecision === 'assign-all') {
      toApply = claimed.map(item => ({ item, finalAction: 'assign' as const }));
    } else {
      toApply = await this.reviewItems(claimed);

      // Reset unreviewed items (stopped early) so they appear on the next run
      const reviewedNumbers = new Set(toApply.map(r => r.item.number));
      for (const item of claimed) {
        if (!reviewedNumbers.has(item.number)) {
          this.results.store.setAnalysis(item.number, { claimDetectedAt: null });
        }
      }
    }

    // Summary
    const assigns = toApply.filter(r => r.finalAction === 'assign');
    const assignLabels = toApply.filter(r => r.finalAction === 'assign-label');
    const keeps = toApply.filter(r => r.finalAction === 'keep');

    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will assign contributor: ${assigns.length}`);
    console.log(`  Will assign + add 'in-progress' label: ${assignLabels.length}`);
    console.log(`  Keep unassigned: ${keeps.length}`);

    // Apply actions
    const actionable = toApply.filter(r => r.finalAction !== 'keep');
    if (actionable.length > 0) {
      await this.applyActions(actionable);
    }
  }

  private async reviewItems(items: ClaimIssueResult[]): Promise<ReviewResult[]> {
    const results: ReviewResult[] = [];
    let stopped = false;

    for (const [i, item] of items.entries()) {
      if (stopped) break;

      console.log(renderClaimIssue(item, i, items.length));

      let decision = await this.askDecision(item);

      if (decision === 'browser') {
        openInBrowser(item.htmlUrl);
        decision = await this.askDecisionAfterBrowser(item);
      }

      if (decision === 'assign') {
        results.push({ item, finalAction: 'assign' });
      } else if (decision === 'assign-label') {
        results.push({ item, finalAction: 'assign-label' });
      } else if (decision === 'keep') {
        results.push({ item, finalAction: 'keep' });
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    return results;
  }

  private async askDecision(item: ClaimIssueResult): Promise<ClaimDecision> {
    return select<ClaimDecision>({
      message: `What do you want to do with #${item.number}?`,
      choices: [
        { name: `Assign @${item.claimant}`, value: 'assign' },
        { name: `Assign @${item.claimant} + add 'in-progress' label`, value: 'assign-label' },
        { name: 'Keep unassigned', value: 'keep' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(item: ClaimIssueResult): Promise<Exclude<ClaimDecision, 'browser'>> {
    return select<Exclude<ClaimDecision, 'browser'>>({
      message: `Now what do you want to do with #${item.number}?`,
      choices: [
        { name: `Assign @${item.claimant}`, value: 'assign' },
        { name: `Assign @${item.claimant} + add 'in-progress' label`, value: 'assign-label' },
        { name: 'Keep unassigned', value: 'keep' },
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

        if (finalAction === 'assign') {
          await github.addAssignees(item.number, [item.claimant]);
          await postAuditComment(github, item.number, [
            `Assigned @${item.claimant}`,
            `Claim detected in comment: "${item.snippet}"`,
          ]);
          console.log(chalk.green(`  ✓ #${item.number}: assigned @${item.claimant}`));

        } else if (finalAction === 'assign-label') {
          await github.addAssignees(item.number, [item.claimant]);
          await github.addLabel(item.number, 'in-progress');
          await postAuditComment(github, item.number, [
            `Assigned @${item.claimant}`,
            `Added \`in-progress\` label`,
            `Claim detected in comment: "${item.snippet}"`,
          ]);
          console.log(chalk.green(`  ✓ #${item.number}: assigned @${item.claimant} + labeled 'in-progress'`));
        }
      }

      await this.results.store.save();
    } catch (error) {
      console.error(chalk.red(`  Failed to apply actions: ${(error as Error).message}`));
    }
  }
}

function renderClaimIssue(
  item: ClaimIssueResult,
  index: number,
  total: number,
): string {
  const lines: string[] = [];
  const header = `CLAIMED ISSUE ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${item.number}  "${item.title}"`);
  lines.push(`  Claimant: ${chalk.cyan(`@${item.claimant}`)}`);
  lines.push(`  Claimed at: ${item.claimedAt}`);
  lines.push('');
  lines.push('  Comment snippet:');
  lines.push(chalk.dim(`  ┌${'─'.repeat(50)}┐`));
  for (const line of item.snippet.split('\n')) {
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
