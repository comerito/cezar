import chalk from 'chalk';
import { resolve } from 'node:path';
import type { Config } from '../../models/config.model.js';
import type { IssueStore } from '../../store/store.js';
import type { StoredIssue } from '../../store/store.model.js';
import { GitHubService } from '../../services/github.service.js';
import { createWorktree, commitAll, getDiffAgainstBase } from './worktree.js';
import { TokenBudget } from './token-budget.js';
import { runAgentSession, type AgentEvent } from './agent-session.js';
import { ANALYZER_SYSTEM_PROMPT, RootCauseSchema, buildAnalyzerUserPrompt, type RootCause } from './prompts/analyzer.js';
import { FIXER_SYSTEM_PROMPT, FixReportSchema, buildFixerUserPrompt, type FixReport } from './prompts/fixer.js';
import { REVIEWER_SYSTEM_PROMPT, ReviewVerdictSchema, buildReviewerUserPrompt, normalizeVerdict, retryNotesFromVerdict, fallbackVerdictFromProse, type ReviewVerdict } from './prompts/reviewer.js';

export type OrchestratorOutcome =
  | { status: 'pr-opened'; prUrl: string; prNumber: number; branch: string; rootCause: RootCause; verdict: ReviewVerdict }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; rootCause?: RootCause; fixReport?: FixReport; verdict?: ReviewVerdict; branch?: string }
  | { status: 'dry-run'; rootCause: RootCause; fixReport: FixReport; verdict: ReviewVerdict; branch: string; diff: string };

// Per-attempt result from runOneAttempt. Only 'review-failed' is retriable;
// other failure kinds bail out of the retry loop immediately.
type AttemptOutcome =
  | { kind: 'pr-opened'; prUrl: string; prNumber: number; rootCause: RootCause; fixReport: FixReport; verdict: Required<ReviewVerdict> }
  | { kind: 'dry-run'; rootCause: RootCause; fixReport: FixReport; verdict: Required<ReviewVerdict>; diff: string }
  | { kind: 'user-declined' }
  | { kind: 'review-failed'; reason: string; rootCause: RootCause; fixReport: FixReport; verdict: Required<ReviewVerdict> }
  | { kind: 'hard-failed'; reason: string; rootCause?: RootCause; fixReport?: FixReport };

export interface OrchestratorOptions {
  apply: boolean;       // false = dry-run (no push, no PR)
  confirmBeforeFix?: (rootCause: RootCause, issue: StoredIssue) => Promise<boolean>;
  onEvent?: (event: string) => void;
  onAgentEvent?: (event: AgentEvent) => void;
}

export class AutofixOrchestrator {
  constructor(
    private readonly store: IssueStore,
    private readonly config: Config,
    private readonly github: GitHubService,
  ) {}

  async processIssue(issueNumber: number, opts: OrchestratorOptions): Promise<OrchestratorOutcome> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) {
      return { status: 'skipped', reason: 'autofix disabled in config' };
    }
    if (!cfg.repoRoot) {
      return { status: 'skipped', reason: 'autofix.repoRoot not set' };
    }

    const issue = this.store.getIssue(issueNumber);
    if (!issue) return { status: 'skipped', reason: `issue #${issueNumber} not found in store` };
    if (issue.state !== 'open') return { status: 'skipped', reason: 'issue is closed' };
    if (issue.analysis.issueType !== 'bug') return { status: 'skipped', reason: 'not classified as a bug' };
    if ((issue.analysis.bugConfidence ?? 0) < cfg.minBugConfidence) {
      return { status: 'skipped', reason: `bug confidence ${issue.analysis.bugConfidence} below threshold ${cfg.minBugConfidence}` };
    }
    if (issue.analysis.autofixStatus === 'pr-opened') {
      return { status: 'skipped', reason: 'PR already opened' };
    }

    const attemptsAlready = issue.analysis.autofixAttempts ?? 0;
    const maxAttempts = cfg.maxAttemptsPerIssue;
    const remainingAttempts = maxAttempts - attemptsAlready;
    if (remainingAttempts <= 0) {
      return { status: 'skipped', reason: 'max attempts reached (use --retry to reset counter)' };
    }

    const repoRoot = resolve(cfg.repoRoot);
    const branch = `${cfg.branchPrefix}${issue.number}`;

    this.markRunning(issueNumber);

    const issueData = await this.github.getIssueWithComments(issueNumber);

    // In-session retry loop. Each iteration is one full analyze → fix → review
    // attempt with its own fresh worktree and token budget. Review failures
    // feed their blocker notes into the next iteration; hard failures break.
    let retryNotes = issue.analysis.autofixReviewNotes ?? undefined;
    let totalTokens = 0;
    let lastOutcome: OrchestratorOutcome | null = null;

    for (let localAttempt = 0; localAttempt < remainingAttempts; localAttempt++) {
      const globalAttempt = attemptsAlready + localAttempt + 1;
      const isFirst = localAttempt === 0;
      const isLast = localAttempt === remainingAttempts - 1;

      opts.onEvent?.(`[#${issueNumber}] Attempt ${globalAttempt}/${maxAttempts} — preparing worktree`);

      let worktree;
      try {
        worktree = await createWorktree({
          repoRoot,
          branch,
          baseBranch: cfg.baseBranch,
          remote: cfg.remote,
          fetchRemote: cfg.fetchBeforeAttempt,
          resetBranch: !isFirst, // retries always start fresh from baseBranch
        });
      } catch (err) {
        // Worktree setup failure is the same next attempt too — hard stop.
        return this.recordFailure(issueNumber, `worktree setup failed: ${(err as Error).message}`, totalTokens);
      }

      this.store.setAnalysis(issueNumber, { autofixWorktreePath: worktree.path, autofixBranch: branch });
      await this.store.save();

      const budget = new TokenBudget(cfg.tokenBudgetPerAttempt);
      let outcome: AttemptOutcome;
      try {
        outcome = await this.runOneAttempt({
          issueNumber, worktree, budget, retryNotes, cfg, issue, issueData,
          confirmBeforeFix: isFirst ? opts.confirmBeforeFix : undefined,
          onEvent: opts.onEvent,
          onAgentEvent: opts.onAgentEvent,
          apply: opts.apply,
        });
      } catch (err) {
        await worktree.dispose().catch(() => {});
        totalTokens += budget.current;
        const msg = err instanceof Error ? err.message : String(err);
        return this.recordFailure(issueNumber, msg, totalTokens, undefined, branch);
      }

      totalTokens += budget.current;

      if (outcome.kind === 'pr-opened' || outcome.kind === 'dry-run') {
        // Success path — save, dispose, return.
        if (outcome.kind === 'pr-opened') {
          this.store.setAnalysis(issueNumber, {
            autofixStatus: 'pr-opened',
            autofixPrUrl: outcome.prUrl,
            autofixPrNumber: outcome.prNumber,
            autofixAttempts: globalAttempt,
            autofixLastRunAt: new Date().toISOString(),
            autofixTokensUsed: totalTokens,
            autofixLastError: null,
            autofixReviewVerdict: outcome.verdict.verdict,
            autofixReviewNotes: outcome.verdict.summary,
          });
        } else {
          this.store.setAnalysis(issueNumber, {
            autofixStatus: 'succeeded',
            autofixAttempts: globalAttempt,
            autofixLastRunAt: new Date().toISOString(),
            autofixTokensUsed: totalTokens,
            autofixLastError: null,
            autofixReviewVerdict: outcome.verdict.verdict,
            autofixReviewNotes: outcome.verdict.summary,
          });
        }
        await this.store.save();
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, { autofixWorktreePath: null });
        await this.store.save();

        if (outcome.kind === 'pr-opened') {
          opts.onEvent?.(`[#${issueNumber}] DONE — ${outcome.prUrl}`);
          return {
            status: 'pr-opened',
            prUrl: outcome.prUrl,
            prNumber: outcome.prNumber,
            branch,
            rootCause: outcome.rootCause,
            verdict: outcome.verdict,
          };
        }
        return {
          status: 'dry-run',
          rootCause: outcome.rootCause,
          fixReport: outcome.fixReport,
          verdict: outcome.verdict,
          branch,
          diff: outcome.diff,
        };
      }

      if (outcome.kind === 'user-declined') {
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, { autofixStatus: 'skipped', autofixWorktreePath: null });
        await this.store.save();
        return { status: 'skipped', reason: 'user declined after analysis' };
      }

      // All remaining kinds are failures. Narrow verdict/fixReport access.
      const failureVerdict = outcome.kind === 'review-failed' ? outcome.verdict : undefined;
      const failureFixReport = outcome.kind === 'review-failed' ? outcome.fixReport : outcome.fixReport;

      this.store.setAnalysis(issueNumber, {
        autofixStatus: 'failed',
        autofixAttempts: globalAttempt,
        autofixLastError: outcome.reason,
        autofixTokensUsed: totalTokens,
        autofixLastRunAt: new Date().toISOString(),
        autofixWorktreePath: null,
        autofixRootCause: outcome.rootCause?.summary ?? null,
        autofixReviewVerdict: failureVerdict?.verdict ?? null,
        autofixReviewNotes: failureVerdict ? retryNotesFromVerdict(failureVerdict) : null,
      });
      await this.store.save();
      await worktree.dispose().catch(() => {});

      lastOutcome = {
        status: 'failed',
        reason: outcome.reason,
        rootCause: outcome.rootCause,
        fixReport: failureFixReport,
        verdict: failureVerdict,
        branch,
      };

      // Only 'review-failed' is retriable. Structural/hard failures break.
      if (outcome.kind !== 'review-failed') {
        return lastOutcome;
      }
      if (!cfg.retryOnReviewFailure || isLast) {
        return lastOutcome;
      }

      retryNotes = retryNotesFromVerdict(outcome.verdict);
      opts.onEvent?.(`[#${issueNumber}] review failed — retrying with reviewer feedback (${outcome.verdict.issues.filter(i => i.severity === 'blocker').length} blocker(s))`);
    }

    // Loop exhausted — shouldn't reach here because the last iteration always
    // returns, but guard anyway.
    return lastOutcome ?? { status: 'failed', reason: 'retry loop exhausted with no outcome', branch };
  }

  private async runOneAttempt(args: {
    issueNumber: number;
    worktree: { path: string };
    budget: TokenBudget;
    retryNotes?: string;
    cfg: NonNullable<Config['autofix']>;
    issue: StoredIssue;
    issueData: { issue: { title: string; body: string }; comments: Array<{ author: string; body: string; createdAt: string }> };
    confirmBeforeFix?: (rootCause: RootCause, issue: StoredIssue) => Promise<boolean>;
    onEvent?: (event: string) => void;
    onAgentEvent?: (event: AgentEvent) => void;
    apply: boolean;
  }): Promise<AttemptOutcome> {
    const { issueNumber, worktree, budget, retryNotes, cfg, issue, issueData } = args;

    args.onEvent?.(`[#${issueNumber}] ANALYZE — locating root cause`);
    const analyzer = await runAgentSession({
      systemPrompt: ANALYZER_SYSTEM_PROMPT,
      userPrompt: buildAnalyzerUserPrompt({
        issueNumber,
        title: issueData.issue.title,
        body: issueData.issue.body,
        comments: issueData.comments,
        digest: issue.digest
          ? {
              summary: issue.digest.summary,
              affectedArea: issue.digest.affectedArea,
              keywords: issue.digest.keywords,
            }
          : undefined,
        priorAttemptNotes: retryNotes,
      }),
      cwd: worktree.path,
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
      bashAllowlist: ['git log', 'git diff', 'git show', 'git status'],
      responseSchema: RootCauseSchema,
      model: cfg.models.analyzer,
      maxTurns: cfg.maxTurns.analyzer,
      tokenBudget: budget,
      onEvent: args.onAgentEvent,
    });

    if (analyzer.budgetExceeded) return { kind: 'hard-failed', reason: 'token budget exceeded during analysis' };
    if (!analyzer.parsed) return { kind: 'hard-failed', reason: 'analyzer did not return a valid RootCause' };

    const rootCause = analyzer.parsed;
    if (rootCause.confidence < cfg.minAnalyzerConfidence) {
      return {
        kind: 'hard-failed',
        reason: `analyzer confidence ${rootCause.confidence.toFixed(2)} below threshold ${cfg.minAnalyzerConfidence}`,
        rootCause,
      };
    }

    if (args.confirmBeforeFix) {
      const proceed = await args.confirmBeforeFix(rootCause, issue);
      if (!proceed) return { kind: 'user-declined' };
    }

    args.onEvent?.(`[#${issueNumber}] FIX — implementing change`);
    const fixer = await runAgentSession({
      systemPrompt: FIXER_SYSTEM_PROMPT,
      userPrompt: buildFixerUserPrompt({
        issueNumber,
        title: issueData.issue.title,
        rootCause,
        priorAttemptNotes: retryNotes,
      }),
      cwd: worktree.path,
      allowedTools: cfg.allowedTools,
      bashAllowlist: cfg.bashAllowlist,
      responseSchema: FixReportSchema,
      model: cfg.models.fixer,
      maxTurns: cfg.maxTurns.fixer,
      tokenBudget: budget,
      onEvent: args.onAgentEvent,
    });

    if (fixer.budgetExceeded) return { kind: 'hard-failed', reason: 'token budget exceeded during fix', rootCause };
    if (!fixer.parsed) return { kind: 'hard-failed', reason: 'fixer did not return a valid FixReport', rootCause };
    const fixReport = fixer.parsed;

    args.onEvent?.(`[#${issueNumber}] COMMIT — staging changes`);
    const commitMessage = buildCommitMessage(issueNumber, issueData.issue.title, fixReport);
    const commitSha = await commitAll(worktree.path, commitMessage);
    if (!commitSha) return { kind: 'hard-failed', reason: 'fixer made no file changes', rootCause, fixReport };

    const diff = await getDiffAgainstBase(worktree.path, cfg.baseBranch);

    args.onEvent?.(`[#${issueNumber}] REVIEW — running code review`);
    const reviewer = await runAgentSession({
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userPrompt: buildReviewerUserPrompt({
        issueNumber,
        title: issueData.issue.title,
        rootCause,
        fixReport,
        diff,
        baseBranch: cfg.baseBranch,
      }),
      cwd: worktree.path,
      allowedTools: ['Read', 'Grep', 'Glob'],
      responseSchema: ReviewVerdictSchema,
      model: cfg.models.reviewer,
      maxTurns: cfg.maxTurns.reviewer,
      tokenBudget: budget,
      onEvent: args.onAgentEvent,
    });

    // If the reviewer emitted prose instead of JSON we recover what we can so
    // the retry loop keeps its signal. Worst case: synthetic fail that tells
    // the fixer "your last diff needs further review — re-verify correctness".
    const verdict: Required<ReviewVerdict> = reviewer.parsed
      ? normalizeVerdict(reviewer.parsed)
      : fallbackVerdictFromProse(reviewer.text);

    const blockers = verdict.issues.filter(i => i.severity === 'blocker').length;
    const passes = cfg.requireReviewPass ? verdict.verdict === 'pass' && blockers === 0 : blockers === 0;

    if (!passes) {
      return {
        kind: 'review-failed',
        reason: reviewer.parsed
          ? `review ${verdict.verdict} (${blockers} blocker(s))`
          : `reviewer emitted prose; recovered verdict=${verdict.verdict} with ${blockers} blocker(s)`,
        rootCause,
        fixReport,
        verdict,
      };
    }

    if (!args.apply) {
      args.onEvent?.(`[#${issueNumber}] DRY-RUN — review passed, skipping push/PR`);
      return { kind: 'dry-run', rootCause, fixReport, verdict, diff };
    }

    args.onEvent?.(`[#${issueNumber}] PUSH — publishing branch`);
    await this.github.pushBranch(cfg.branchPrefix + issueNumber, worktree.path, cfg.remote);

    args.onEvent?.(`[#${issueNumber}] PR — opening draft pull request`);
    const prBody = buildPrBody(issueNumber, rootCause, fixReport, verdict);
    const pr = await this.github.createPullRequest({
      title: `fix: ${issueData.issue.title} (#${issueNumber})`,
      body: prBody,
      head: cfg.branchPrefix + issueNumber,
      base: cfg.baseBranch,
      draft: cfg.draftPr,
      labels: cfg.prLabels,
    });

    return { kind: 'pr-opened', prUrl: pr.url, prNumber: pr.number, rootCause, fixReport, verdict };
  }

  private markRunning(issueNumber: number): void {
    this.store.setAnalysis(issueNumber, {
      autofixStatus: 'running',
      autofixLastRunAt: new Date().toISOString(),
    });
  }

  private async recordFailure(
    issueNumber: number,
    reason: string,
    tokens: number,
    dispose?: () => Promise<void>,
    branch?: string,
    artifacts?: { rootCause?: RootCause; fixReport?: FixReport; verdict?: ReviewVerdict },
  ): Promise<OrchestratorOutcome> {
    if (dispose) await dispose().catch(() => {});
    const issue = this.store.getIssue(issueNumber);
    const attempts = (issue?.analysis.autofixAttempts ?? 0) + 1;
    this.store.setAnalysis(issueNumber, {
      autofixStatus: 'failed',
      autofixAttempts: attempts,
      autofixLastError: reason,
      autofixTokensUsed: tokens,
      autofixLastRunAt: new Date().toISOString(),
      autofixWorktreePath: null,
    });
    await this.store.save();
    return {
      status: 'failed',
      reason,
      rootCause: artifacts?.rootCause,
      fixReport: artifacts?.fixReport,
      verdict: artifacts?.verdict,
      branch,
    };
  }
}

function buildCommitMessage(issueNumber: number, title: string, report: FixReport): string {
  return `fix: ${title} (#${issueNumber})

${report.approach}

Fixes #${issueNumber}

Co-authored-by: cezar-autofix <noreply@cezar>
`;
}

function buildPrBody(issueNumber: number, rootCause: RootCause, fixReport: FixReport, verdict: Required<ReviewVerdict>): string {
  const concerns = (fixReport.remainingConcerns ?? []).map(c => `- ${c}`).join('\n') || '_(none)_';
  const reviewIssues = verdict.issues.length === 0
    ? '_(no issues raised)_'
    : verdict.issues.map(i => `- **${i.severity}** ${i.file ? `\`${i.file}\`${i.line ? `:${i.line}` : ''}` : ''}: ${i.comment}`).join('\n');

  return `## Automated fix for #${issueNumber}

Fixes #${issueNumber}

> This PR was opened by [cezar](https://github.com/comerito/cezar) autofix. It is a **draft** — a human reviewer must verify correctness before it merges.

### Root cause
${rootCause.summary}

${rootCause.hypothesis}

### Approach
${fixReport.approach}

### Files changed
${fixReport.changedFiles.map(f => `- \`${f}\``).join('\n') || '_(none)_'}

### Verification
Commands run by the fixer:
${fixReport.testCommandsRun.map(c => `- \`${c}\``).join('\n') || '_(none)_'}

### Review (automated)
**Verdict:** \`${verdict.verdict}\`

${verdict.summary}

Issues raised:
${reviewIssues}

### Remaining concerns
${concerns}
`;
}

