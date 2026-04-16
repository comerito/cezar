import chalk from 'chalk';
import type { StoredIssue, Config, IssueStore, ConfirmationPort } from '@cezar/core';
import { AutofixRunner, type AutofixOptions, type AutofixResults } from './runner.js';
import type { RootCause } from './prompts/analyzer.js';
import { TerminalConfirmAdapter } from '../../adapters/terminal-confirm.adapter.js';

export class AutofixInteractiveUI {
  private readonly confirmation: ConfirmationPort;

  constructor(
    private readonly store: IssueStore,
    private readonly config: Config,
    confirmation?: ConfirmationPort,
  ) {
    this.confirmation = confirmation ?? new TerminalConfirmAdapter();
  }

  async present(options: AutofixOptions): Promise<AutofixResults> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) {
      console.log(chalk.yellow('Autofix is disabled. Enable it in config first (autofix.enabled = true).'));
      return new AutofixRunner(this.store, this.config).run(options);
    }
    if (!cfg.repoRoot) {
      console.log(chalk.red('autofix.repoRoot is not configured. Cannot run.'));
      return new AutofixRunner(this.store, this.config).run(options);
    }

    const apply = options.apply === true && !options.dryRun;

    const proceed = await this.confirmation.confirmPreflight({
      repoRoot: cfg.repoRoot,
      baseBranch: cfg.baseBranch,
      mode: apply ? 'apply' : 'dry-run',
      maxAttemptsPerIssue: cfg.maxAttemptsPerIssue,
      tokenBudgetPerAttempt: cfg.tokenBudgetPerAttempt,
      eligibleIssueCount: this.store.getIssues({ state: 'open' }).length,
    });
    if (!proceed) {
      return new AutofixRunner(this.store, this.config).run({ ...options, maxIssues: 0 });
    }

    const runnerOpts: AutofixOptions = {
      ...options,
      apply,
      confirmBeforeFix: (rootCause, issue) => this.confirmRootCause(rootCause, issue),
    };

    const runner = new AutofixRunner(this.store, this.config);
    const results = await runner.run(runnerOpts);
    results.print();
    return results;
  }

  private async confirmRootCause(rootCause: RootCause, issue: StoredIssue): Promise<boolean> {
    const decision = await this.confirmation.confirmRootCause({
      issueNumber: issue.number,
      issueTitle: issue.title,
      rootCause: `${rootCause.summary}\n  Hypothesis: ${rootCause.hypothesis}`,
      confidence: rootCause.confidence,
      evidence: rootCause.suspectedFiles,
    });
    return decision === 'proceed';
  }
}
