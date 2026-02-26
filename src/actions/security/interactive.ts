import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Config } from '../../models/config.model.js';
import type { SecurityFinding, SecurityResults } from './runner.js';
import { GitHubService } from '../../services/github.service.js';
import { postAuditComment } from '../../services/audit.js';
import { confirmAction } from '../../ui/components/confirm.js';
import { execFile } from 'node:child_process';

type InitialDecision = 'review' | 'label-all' | 'skip-all';
type SecurityDecision = 'label' | 'label-comment' | 'skip' | 'browser' | 'stop';

interface ReviewResult {
  finding: SecurityFinding;
  postNote: boolean;
}

const SEVERITY_COLORS: Record<string, (s: string) => string> = {
  critical: chalk.red.bold,
  high: chalk.red,
  medium: chalk.yellow,
  low: chalk.dim,
};

export class SecurityInteractiveUI {
  private results: SecurityResults;
  private config: Config;

  constructor(results: SecurityResults, config: Config) {
    this.results = results;
    this.config = config;
  }

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No security findings.');
      return;
    }

    // Alert-first summary
    console.log('');
    console.log(chalk.red.bold('⚠  SECURITY SCAN COMPLETE'));
    console.log('═'.repeat(55));
    console.log('');
    console.log(`  ${this.results.findings.length} issue(s) may contain security implications:`);
    console.log('');

    for (const finding of this.results.findings) {
      const color = SEVERITY_COLORS[finding.severity] ?? chalk.dim;
      console.log(`  #${finding.number}  ${finding.title}`);
      console.log(`        Category: ${finding.category}`);
      console.log(`        Confidence: ${Math.round(finding.confidence * 100)}%    Severity: ${color(finding.severity)}`);
      console.log('');
    }

    const initialDecision = await select<InitialDecision>({
      message: 'How do you want to handle these?',
      choices: [
        { name: 'Review each finding', value: 'review' },
        { name: "Add 'security' label to all", value: 'label-all' },
        { name: 'Skip all — no action needed', value: 'skip-all' },
      ],
    });

    if (initialDecision === 'skip-all') {
      // Clear security flags for all
      for (const finding of this.results.findings) {
        this.results.store.setAnalysis(finding.number, {
          securityFlag: null,
          securityConfidence: null,
          securityCategory: null,
          securitySeverity: null,
        });
      }
      await this.results.store.save();
      console.log(chalk.dim('  All findings skipped.'));
      return;
    }

    if (initialDecision === 'label-all') {
      const toApply = this.results.findings.map(f => ({ finding: f, postNote: false }));
      await this.applyLabels(toApply);
      return;
    }

    // Review each finding
    const toApply: ReviewResult[] = [];
    const skipped: SecurityFinding[] = [];
    let stopped = false;

    for (const [i, finding] of this.results.findings.entries()) {
      if (stopped) break;

      console.log(renderFinding(finding, i, this.results.findings.length));

      let decision = await this.askDecision(finding);

      if (decision === 'browser') {
        openInBrowser(finding.htmlUrl);
        decision = await this.askDecisionAfterBrowser(finding);
      }

      if (decision === 'label') {
        toApply.push({ finding, postNote: false });
      } else if (decision === 'label-comment') {
        toApply.push({ finding, postNote: true });
      } else if (decision === 'skip') {
        skipped.push(finding);
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    // Summary
    console.log('');
    console.log(chalk.bold('Review complete'));
    console.log('─'.repeat(55));
    console.log(`  Will label:  ${toApply.length}`);
    console.log(`  Skipped:     ${skipped.length}`);

    // Handle skips — clear security flags
    for (const finding of skipped) {
      this.results.store.setAnalysis(finding.number, {
        securityFlag: null,
        securityConfidence: null,
        securityCategory: null,
        securitySeverity: null,
      });
    }
    await this.results.store.save();

    // Apply labels if any
    if (toApply.length > 0) {
      await this.applyLabels(toApply);
    }
  }

  private async applyLabels(toApply: ReviewResult[]): Promise<void> {
    const shouldApply = await confirmAction(
      `Add 'security' label to ${toApply.length} issue(s) on GitHub?`,
    );

    if (shouldApply) {
      try {
        const github = new GitHubService(this.config);
        for (const review of toApply) {
          await github.addLabel(review.finding.number, 'security');

          const auditActions = [
            `Flagged as security issue: ${review.finding.category} (${review.finding.severity})`,
            `Added \`security\` label`,
          ];

          if (review.postNote) {
            const note = formatSecurityNote(review.finding);
            await github.addComment(review.finding.number, note);
            auditActions.push('Posted security triage note');
          }

          await postAuditComment(github, review.finding.number, auditActions);

          console.log(chalk.green(`  ✓ #${review.finding.number}: labeled [${review.finding.severity}]`));
        }
        await this.results.store.save();
      } catch (error) {
        console.error(chalk.red(`  Failed to apply labels: ${(error as Error).message}`));
      }
    }
  }

  private async askDecision(finding: SecurityFinding): Promise<SecurityDecision> {
    return select<SecurityDecision>({
      message: `What do you want to do with #${finding.number}?`,
      choices: [
        { name: "Add 'security' label on GitHub", value: 'label' },
        { name: "Add 'security' label + post triage note comment", value: 'label-comment' },
        { name: 'Skip — not a security issue', value: 'skip' },
        { name: 'Open in browser', value: 'browser' },
        { name: 'Stop reviewing (keep decisions so far)', value: 'stop' },
      ],
    });
  }

  private async askDecisionAfterBrowser(finding: SecurityFinding): Promise<Exclude<SecurityDecision, 'browser'>> {
    return select<Exclude<SecurityDecision, 'browser'>>({
      message: `Now what do you want to do with #${finding.number}?`,
      choices: [
        { name: "Add 'security' label on GitHub", value: 'label' },
        { name: "Add 'security' label + post triage note comment", value: 'label-comment' },
        { name: 'Skip — not a security issue', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }
}

function renderFinding(finding: SecurityFinding, index: number, total: number): string {
  const lines: string[] = [];
  const header = `FINDING ${index + 1} of ${total}`;
  lines.push('');
  lines.push(chalk.bold(`${header} ${'─'.repeat(Math.max(0, 50 - header.length))}`));
  lines.push('');
  lines.push(`  #${finding.number}  ${finding.title}`);
  const color = SEVERITY_COLORS[finding.severity] ?? chalk.dim;
  lines.push(`  Category:   ${finding.category}`);
  lines.push(`  Severity:   ${color(finding.severity)}`);
  lines.push(`  Confidence: ${Math.round(finding.confidence * 100)}%`);
  lines.push('');
  lines.push(`  ${finding.explanation}`);
  lines.push('');
  return lines.join('\n');
}

function formatSecurityNote(finding: SecurityFinding): string {
  return `🔒 **Security triage note**\n\n**Category:** ${finding.category}\n**Severity:** ${finding.severity}\n**Confidence:** ${Math.round(finding.confidence * 100)}%\n\n${finding.explanation}`;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args);
}
