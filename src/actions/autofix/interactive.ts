import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { StoredIssue } from '../../store/store.model.js';
import type { Config } from '../../models/config.model.js';
import type { IssueStore } from '../../store/store.js';
import { AutofixRunner, type AutofixOptions, type AutofixResults } from './runner.js';
import type { RootCause } from './prompts/analyzer.js';

export class AutofixInteractiveUI {
  constructor(
    private readonly store: IssueStore,
    private readonly config: Config,
  ) {}

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
    console.log('');
    console.log(chalk.bold('Autofix preflight'));
    console.log('─'.repeat(55));
    console.log(`  Repo root:   ${cfg.repoRoot}`);
    console.log(`  Base branch: ${cfg.baseBranch}`);
    console.log(`  Mode:        ${apply ? chalk.green('APPLY') : chalk.cyan('DRY-RUN')}`);
    console.log(`  Max attempts per issue: ${cfg.maxAttemptsPerIssue}`);
    console.log(`  Token budget per attempt: ${cfg.tokenBudgetPerAttempt.toLocaleString()}`);
    console.log('');

    const proceed = await confirm({
      message: apply
        ? 'Proceed? This WILL push branches and open draft PRs for bug issues.'
        : 'Proceed with dry-run? No branches will be pushed.',
      default: !apply,
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
    console.log('');
    console.log(chalk.bold(`Root-cause analysis for #${issue.number}`));
    console.log('─'.repeat(55));
    console.log(`  Title:      ${issue.title}`);
    console.log(`  Summary:    ${rootCause.summary}`);
    console.log(`  Hypothesis: ${rootCause.hypothesis}`);
    console.log(`  Confidence: ${rootCause.confidence.toFixed(2)}`);
    console.log(`  Suspected:  ${rootCause.suspectedFiles.join(', ') || '(none)'}`);
    console.log('');

    const decision = await select<'proceed' | 'skip'>({
      message: 'Proceed with fix implementation?',
      choices: [
        { name: 'Proceed — let the fixer agent make the change', value: 'proceed' },
        { name: 'Skip this issue', value: 'skip' },
      ],
    });
    return decision === 'proceed';
  }
}
