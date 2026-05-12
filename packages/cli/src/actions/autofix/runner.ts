import ora from 'ora';
import chalk from 'chalk';
import type { Config } from '@cezar/core';
import type { IssueStore } from '@cezar/core';
import type { StoredIssue } from '@cezar/core';
import { GitHubService, applyPipelineExclusions, AutofixOrchestrator, type OrchestratorOutcome, type AgentRunRecord } from '@cezar/core';
import type { RootCause } from '@cezar/core';
import { verboseToggle } from './verbose.js';
import { runsDir, recordsToSteps, writeRunSummary } from '../../utils/runs-store.js';

export interface AutofixOptions {
  apply?: boolean;
  dryRun?: boolean;
  issue?: number;
  maxIssues?: number;
  retry?: boolean;
  excludeIssues?: Set<number>;
  confirmBeforeFix?: (rootCause: RootCause, issue: StoredIssue) => Promise<boolean>;
}

export interface AutofixItemResult {
  issueNumber: number;
  title: string;
  htmlUrl: string;
  outcome: OrchestratorOutcome;
}

export class AutofixResults {
  constructor(
    public readonly items: AutofixItemResult[],
    public readonly message?: string,
  ) {}

  static empty(message: string): AutofixResults {
    return new AutofixResults([], message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }
    if (this.isEmpty) {
      console.log('No issues processed.');
      return;
    }

    const counts = {
      opened: 0,
      dryRun: 0,
      failed: 0,
      skipped: 0,
    };

    for (const item of this.items) {
      const s = item.outcome.status;
      if (s === 'pr-opened') counts.opened++;
      else if (s === 'dry-run') counts.dryRun++;
      else if (s === 'failed') counts.failed++;
      else counts.skipped++;
    }

    console.log('');
    console.log(chalk.bold('Autofix summary'));
    console.log('─'.repeat(55));
    for (const item of this.items) {
      const prefix = `  #${item.issueNumber}`;
      if (item.outcome.status === 'pr-opened') {
        console.log(`${prefix} ${chalk.green('✓ PR opened')} → ${item.outcome.prUrl}`);
      } else if (item.outcome.status === 'dry-run') {
        console.log(`${prefix} ${chalk.cyan('✓ dry-run passed')} (branch: ${item.outcome.branch})`);
      } else if (item.outcome.status === 'failed') {
        console.log(`${prefix} ${chalk.red('✗ failed')} — ${item.outcome.reason}`);
      } else {
        console.log(`${prefix} ${chalk.dim('skipped')} — ${item.outcome.reason}`);
      }
    }
    console.log('');
    console.log(
      `  PR opened: ${counts.opened}  ·  Dry-run: ${counts.dryRun}  ·  ` +
      `Failed: ${counts.failed}  ·  Skipped: ${counts.skipped}`,
    );
  }
}

function outcomeSummary(o: OrchestratorOutcome): string {
  switch (o.status) {
    case 'pr-opened': return `PR opened: ${o.prUrl}`;
    case 'dry-run': return `dry-run passed (branch: ${o.branch})`;
    case 'failed': return `failed: ${o.reason}`;
    case 'skipped': return `skipped: ${o.reason}`;
  }
}

export class AutofixRunner {
  private store: IssueStore;
  private config: Config;
  private githubService?: GitHubService;

  constructor(store: IssueStore, config: Config, githubService?: GitHubService) {
    this.store = store;
    this.config = config;
    this.githubService = githubService;
  }

  async run(options: AutofixOptions = {}): Promise<AutofixResults> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) {
      return AutofixResults.empty('Autofix is disabled. Set autofix.enabled=true in config.');
    }
    if (!cfg.repoRoot) {
      return AutofixResults.empty(
        'Autofix requires autofix.repoRoot to be set to an external checkout. Refusing to run.',
      );
    }

    const candidates = this.selectCandidates(options);
    if (candidates.length === 0) {
      return AutofixResults.empty('No bug issues meet the autofix criteria.');
    }

    const limited = options.maxIssues ? candidates.slice(0, options.maxIssues) : candidates;
    const github = this.githubService ?? new GitHubService(this.config);
    const orchestrator = new AutofixOrchestrator(this.store, this.config, github);
    const apply = options.apply === true && !options.dryRun;

    if (options.retry) {
      for (const issue of limited) {
        this.resetAttempt(issue.number);
      }
      await this.store.save();
    }

    const spinner = ora().start();
    const items: AutofixItemResult[] = [];

    // Events matching these prefixes print as permanent log lines in addition
    // to updating the spinner. Everything else just updates the spinner text.
    // Retry milestones and PR-open URLs need to be visible after the run even
    // if the spinner has since overwritten them.
    const permanentLogPatterns = [
      /] Attempt \d+\/\d+ /,
      /] review failed — retrying/,
      /] DRY-RUN /,
      /] PUSH /,
      /] PR /,
      /] DONE /,
    ];

    const emitEvent = (evt: string): void => {
      verboseToggle.setStage(evt);
      if (permanentLogPatterns.some(re => re.test(evt))) {
        spinner.clear();
        process.stdout.write(`  ${chalk.dim(evt)}\n`);
        spinner.render();
      }
    };

    // When the workflow engine is on, mirror each run to `.cezar/runs/` so the
    // local `cezar runs` command has something to show (the SaaS equivalent is
    // the web cockpit backed by `workflow_runs`/`agent_runs`).
    const useEngine = this.config.workflow?.useEngine === true;
    const localRunsDir = runsDir(this.config.store?.path);

    verboseToggle.install(spinner);
    try {
      for (const issue of limited) {
        const stage = `Processing #${issue.number}: ${issue.title}`;
        verboseToggle.setStage(stage);
        const records: AgentRunRecord[] = [];
        const startedAt = new Date().toISOString();
        const outcome = await orchestrator.processIssue(issue.number, {
          apply,
          confirmBeforeFix: options.confirmBeforeFix,
          onEvent: emitEvent,
          onAgentEvent: (evt) => { verboseToggle.onAgentEvent(evt); },
          onRunRecord: useEngine ? (r) => { records.push(r); } : undefined,
        });
        items.push({
          issueNumber: issue.number,
          title: issue.title,
          htmlUrl: issue.htmlUrl,
          outcome,
        });
        if (useEngine && records.length > 0) {
          try {
            await writeRunSummary(localRunsDir, {
              id: records[0]!.id,
              workflow: records[0]!.workflow,
              issueNumber: issue.number,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: outcome.status === 'pr-opened' || outcome.status === 'dry-run' ? 'finished' : outcome.status,
              steps: recordsToSteps(records),
              outcome: outcomeSummary(outcome),
            });
          } catch {
            // Best-effort: a failed mirror write must not fail the run.
          }
        }
      }
    } finally {
      verboseToggle.uninstall();
    }

    spinner.succeed(`Autofix processed ${items.length} issue(s)`);
    return new AutofixResults(items);
  }

  private selectCandidates(options: AutofixOptions): StoredIssue[] {
    const cfg = this.config.autofix!;

    if (options.issue !== undefined) {
      const issue = this.store.getIssue(options.issue);
      return issue ? [issue] : [];
    }

    const all = this.store.getIssues({ state: 'open' });
    const filtered = all.filter(i =>
      i.analysis.issueType === 'bug' &&
      (i.analysis.bugConfidence ?? 0) >= cfg.minBugConfidence &&
      (options.retry || (i.analysis.autofixAttempts ?? 0) < cfg.maxAttemptsPerIssue) &&
      i.analysis.autofixStatus !== 'pr-opened',
    );
    return applyPipelineExclusions(filtered, options);
  }

  private resetAttempt(issueNumber: number): void {
    const issue = this.store.getIssue(issueNumber);
    if (!issue) return;
    if (issue.analysis.autofixStatus === 'pr-opened') return;
    this.store.setAnalysis(issueNumber, {
      autofixStatus: null,
      autofixAttempts: 0,
      autofixLastError: null,
      autofixLastRunAt: null,
      autofixTokensUsed: 0,
      autofixWorktreePath: null,
      autofixRootCause: null,
      autofixReviewVerdict: null,
      // Keep autofixReviewNotes so prior feedback still feeds the retry prompts.
    });
  }
}
