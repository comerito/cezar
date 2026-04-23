import { resolve } from 'node:path';
import type { Config } from '../../config/config.model.js';
import type { IssueStore } from '../../store/store.js';
import type { StoredIssue } from '../../store/store.model.js';
import { GitHubService } from '../../services/github.service.js';
import { createWorktree, commitAll, getDiffAgainstBase, fetchRemoteBranch } from './worktree.js';
import { runSetupCommand } from './setup-runner.js';
import { TokenBudget } from './token-budget.js';
import { runAgentSession, type AgentEvent } from './agent-session.js';
import { ANALYZER_SYSTEM_PROMPT, AnalyzerResultSchema, isNoActionNeeded, buildAnalyzerUserPrompt, type RootCause } from './prompts/analyzer.js';
import { FIXER_SYSTEM_PROMPT, FixReportSchema, buildFixerUserPrompt, type FixReport } from './prompts/fixer.js';
import { REVIEWER_SYSTEM_PROMPT, ReviewVerdictSchema, buildReviewerUserPrompt, normalizeVerdict, retryNotesFromVerdict, fallbackVerdictFromProse, type ReviewVerdict } from './prompts/reviewer.js';

export type OrchestratorOutcome =
  | { status: 'pr-opened'; prUrl: string; prNumber: number; branch: string; headSha: string; rootCause: RootCause; verdict: ReviewVerdict }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; rootCause?: RootCause; fixReport?: FixReport; verdict?: ReviewVerdict; branch?: string }
  | { status: 'dry-run'; rootCause: RootCause; fixReport: FixReport; verdict: ReviewVerdict; branch: string; diff: string };

export interface CiFollowupInput {
  issueNumber: number;
  prNumber: number;
  branch: string;
  attemptIndex: number;    // 1-based — which follow-up attempt this is for the flow
  attemptMax: number;
  attribution: {
    reasoning: string;
    suggestedFocus?: string;
    preExistingChecks?: string[];
  };
  failedCheckNames: string[];
  logTails?: Array<{ checkName: string; lines: string[] }>;
}

export type CiFollowupOutcome =
  | { status: 'pushed'; branch: string; headSha: string; verdict: Required<ReviewVerdict>; fixReport: FixReport }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; branch?: string; verdict?: Required<ReviewVerdict>; fixReport?: FixReport };

// Per-attempt result from runOneAttempt. Only 'review-failed' is retriable;
// other failure kinds bail out of the retry loop immediately.
type AttemptOutcome =
  | { kind: 'pr-opened'; prUrl: string; prNumber: number; headSha: string; rootCause: RootCause; fixReport: FixReport; verdict: Required<ReviewVerdict> }
  | { kind: 'dry-run'; rootCause: RootCause; fixReport: FixReport; verdict: Required<ReviewVerdict>; diff: string }
  | { kind: 'user-declined' }
  | { kind: 'no-action-needed'; reason: string }
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

      // Run any user-configured env setup (yarn install, db migrate, etc.)
      // before the analyzer/fixer touch the worktree. Each attempt re-runs
      // setup because every retry creates a fresh worktree.
      if (cfg.setupCommands && cfg.setupCommands.length > 0) {
        opts.onEvent?.(`[#${issueNumber}] SETUP — running ${cfg.setupCommands.length} command(s)`);
        for (const command of cfg.setupCommands) {
          opts.onEvent?.(`[#${issueNumber}] $ ${command}`);
          const result = await runSetupCommand(command, worktree.path, (line) => {
            opts.onEvent?.(`  ${line}`);
          });
          if (!result.ok) {
            await worktree.dispose().catch(() => {});
            const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
            return this.recordFailure(
              issueNumber,
              `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
              totalTokens,
              undefined,
              branch,
            );
          }
        }
      }

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
            headSha: outcome.headSha,
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

      if (outcome.kind === 'no-action-needed') {
        await worktree.dispose();
        this.store.setAnalysis(issueNumber, {
          autofixStatus: 'skipped',
          autofixWorktreePath: null,
          autofixAttempts: globalAttempt,
          autofixLastRunAt: new Date().toISOString(),
          autofixTokensUsed: totalTokens,
          autofixLastError: null,
        });
        await this.store.save();
        opts.onEvent?.(`[#${issueNumber}] SKIPPED — ${outcome.reason}`);
        return { status: 'skipped', reason: outcome.reason };
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
      responseSchema: AnalyzerResultSchema,
      model: cfg.models.analyzer,
      maxTurns: cfg.maxTurns.analyzer,
      tokenBudget: budget,
      onEvent: args.onAgentEvent,
    });

    if (analyzer.budgetExceeded) return { kind: 'hard-failed', reason: 'token budget exceeded during analysis' };
    if (!analyzer.parsed) {
      const tail = analyzer.text.slice(-400).trim();
      return {
        kind: 'hard-failed',
        reason: tail
          ? `analyzer did not return a valid JSON response. Last output: "${tail}"`
          : 'analyzer returned no parseable output (likely hit maxTurns without emitting JSON)',
      };
    }

    if (isNoActionNeeded(analyzer.parsed)) {
      return { kind: 'no-action-needed', reason: analyzer.parsed.reason };
    }

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

    return { kind: 'pr-opened', prUrl: pr.url, prNumber: pr.number, headSha: commitSha, rootCause, fixReport, verdict };
  }

  /**
   * Follow-up attempt triggered after attribution concludes a CI failure on
   * an already-opened autofix PR was caused by our changes. Unlike
   * processIssue, this:
   *   - starts from the EXISTING PR branch, not baseBranch
   *   - skips the analyzer (attribution already told us what to focus on)
   *   - pushes new commits to the same branch (PR auto-updates)
   *   - does NOT open a new PR
   *   - posts a PR comment explaining what changed
   *
   * One attempt per call. The ci-fix cron loops if attempts remain.
   */
  async processCiFollowup(input: CiFollowupInput, opts: OrchestratorOptions): Promise<CiFollowupOutcome> {
    const cfg = this.config.autofix;
    if (!cfg || !cfg.enabled) return { status: 'skipped', reason: 'autofix disabled in config' };
    if (!cfg.repoRoot) return { status: 'skipped', reason: 'autofix.repoRoot not set' };

    const issue = this.store.getIssue(input.issueNumber);
    if (!issue) return { status: 'skipped', reason: `issue #${input.issueNumber} not found in store` };

    const repoRoot = resolve(cfg.repoRoot);
    const issueData = await this.github.getIssueWithComments(input.issueNumber);

    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX ${input.attemptIndex}/${input.attemptMax} — fetching branch ${input.branch}`);

    // Materialise the PR branch locally. The follow-up worktree attaches to
    // the existing branch (resetBranch:false) so the prior autofix commits
    // stay — we're extending the PR, not replacing it.
    try {
      await fetchRemoteBranch(repoRoot, cfg.remote, input.branch);
    } catch (err) {
      return { status: 'failed', reason: `failed to fetch ${cfg.remote}/${input.branch}: ${(err as Error).message}`, branch: input.branch };
    }

    let worktree;
    try {
      worktree = await createWorktree({
        repoRoot,
        branch: input.branch,
        baseBranch: cfg.baseBranch,
        remote: cfg.remote,
        fetchRemote: cfg.fetchBeforeAttempt,
        resetBranch: false,
      });
    } catch (err) {
      return { status: 'failed', reason: `worktree setup failed: ${(err as Error).message}`, branch: input.branch };
    }

    // Re-run setup commands (fresh worktree, no deps installed yet).
    if (cfg.setupCommands && cfg.setupCommands.length > 0) {
      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX SETUP — running ${cfg.setupCommands.length} command(s)`);
      for (const command of cfg.setupCommands) {
        opts.onEvent?.(`[#${input.issueNumber}] $ ${command}`);
        const result = await runSetupCommand(command, worktree.path, (line) => {
          opts.onEvent?.(`  ${line}`);
        });
        if (!result.ok) {
          await worktree.dispose().catch(() => {});
          const tail = (result.stderr || result.stdout).split('\n').slice(-5).join(' | ').trim();
          return {
            status: 'failed',
            reason: `env setup failed: \`${command}\` exited ${result.exitCode}${tail ? ` — ${tail}` : ''}`,
            branch: input.branch,
          };
        }
      }
    }

    const budget = new TokenBudget(cfg.ciFixTokenBudget ?? cfg.tokenBudgetPerAttempt);

    // Attribution IS our root-cause diagnosis. Confidence=1 because the
    // attributor already cleared the "is this ours?" hurdle; the fixer
    // shouldn't second-guess that.
    const rootCause: RootCause = {
      summary: input.attribution.suggestedFocus
        ? `CI follow-up: ${input.attribution.suggestedFocus}`
        : `CI failure on PR #${input.prNumber} attributed to this autofix`,
      hypothesis: input.attribution.reasoning,
      suspectedFiles: [],
      reproductionNotes: input.failedCheckNames.length > 0
        ? `Failing CI checks: ${input.failedCheckNames.join(', ')}`
        : undefined,
      confidence: 1,
    };

    const priorAttemptNotes = buildCiFollowupNotes(input);

    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX FIX — implementing adjustment`);
    const fixer = await runAgentSession({
      systemPrompt: FIXER_SYSTEM_PROMPT,
      userPrompt: buildFixerUserPrompt({
        issueNumber: input.issueNumber,
        title: issueData.issue.title,
        rootCause,
        priorAttemptNotes,
      }),
      cwd: worktree.path,
      allowedTools: cfg.allowedTools,
      bashAllowlist: cfg.bashAllowlist,
      responseSchema: FixReportSchema,
      model: cfg.models.fixer,
      maxTurns: cfg.maxTurns.fixer,
      tokenBudget: budget,
      onEvent: opts.onAgentEvent,
    });

    if (fixer.budgetExceeded) {
      await worktree.dispose().catch(() => {});
      return { status: 'failed', reason: 'token budget exceeded during CI follow-up fix', branch: input.branch };
    }
    if (!fixer.parsed) {
      await worktree.dispose().catch(() => {});
      return { status: 'failed', reason: 'fixer did not return a valid FixReport for CI follow-up', branch: input.branch };
    }
    const fixReport = fixer.parsed;

    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX COMMIT — staging changes`);
    const commitMessage = buildCiFollowupCommitMessage(input, issueData.issue.title, fixReport);
    const commitSha = await commitAll(worktree.path, commitMessage);
    if (!commitSha) {
      await worktree.dispose().catch(() => {});
      return { status: 'skipped', reason: 'fixer made no file changes — CI failure may no longer reproduce' };
    }

    const diff = await getDiffAgainstBase(worktree.path, cfg.baseBranch);

    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX REVIEW — running code review`);
    const reviewer = await runAgentSession({
      systemPrompt: REVIEWER_SYSTEM_PROMPT,
      userPrompt: buildReviewerUserPrompt({
        issueNumber: input.issueNumber,
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
      onEvent: opts.onAgentEvent,
    });

    const verdict: Required<ReviewVerdict> = reviewer.parsed
      ? normalizeVerdict(reviewer.parsed)
      : fallbackVerdictFromProse(reviewer.text);

    const blockers = verdict.issues.filter(i => i.severity === 'blocker').length;
    const passes = cfg.requireReviewPass ? verdict.verdict === 'pass' && blockers === 0 : blockers === 0;

    if (!passes) {
      await worktree.dispose().catch(() => {});
      return {
        status: 'failed',
        reason: `CI follow-up review ${verdict.verdict} (${blockers} blocker(s))`,
        verdict,
        fixReport,
        branch: input.branch,
      };
    }

    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX PUSH — updating PR #${input.prNumber}`);
    try {
      await this.github.pushBranch(input.branch, worktree.path, cfg.remote);
    } catch (err) {
      await worktree.dispose().catch(() => {});
      return { status: 'failed', reason: `push failed: ${(err as Error).message}`, verdict, fixReport, branch: input.branch };
    }

    // PR-comment is best-effort — don't fail the attempt just because we
    // couldn't attach a note. The commit itself is the source of truth.
    try {
      await this.github.addComment(input.prNumber, buildCiFollowupPrComment(input, fixReport, verdict));
    } catch (err) {
      opts.onEvent?.(`[#${input.issueNumber}] CI-FIX NOTE — could not post PR comment: ${(err as Error).message}`);
    }

    await worktree.dispose().catch(() => {});
    opts.onEvent?.(`[#${input.issueNumber}] CI-FIX DONE — ${commitSha.slice(0, 8)} pushed to ${input.branch}`);

    return { status: 'pushed', branch: input.branch, headSha: commitSha, verdict, fixReport };
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

function buildCiFollowupNotes(input: CiFollowupInput): string {
  const parts: string[] = [];
  parts.push('CI FAILURE CONTEXT — this is a follow-up adjustment. The prior autofix commit caused CI to fail.');
  parts.push('');
  parts.push(`Attribution reasoning:\n${input.attribution.reasoning}`);
  if (input.attribution.suggestedFocus) {
    parts.push(`\nSuggested focus:\n${input.attribution.suggestedFocus}`);
  }
  if (input.failedCheckNames.length > 0) {
    parts.push(`\nFailing checks to make green: ${input.failedCheckNames.join(', ')}`);
  }
  if (input.logTails && input.logTails.length > 0) {
    parts.push('\nFailing job log tails:');
    for (const t of input.logTails) {
      const tail = t.lines.slice(-40).join('\n');
      parts.push(`\n### ${t.checkName}\n\`\`\`\n${tail}\n\`\`\``);
    }
  }
  parts.push('\nMake the minimum change that turns the failing checks green without breaking the existing fix.');
  return parts.join('\n');
}

function buildCiFollowupCommitMessage(input: CiFollowupInput, title: string, report: FixReport): string {
  return `fix: CI follow-up for ${title} (#${input.issueNumber})

${report.approach}

Attempt ${input.attemptIndex}/${input.attemptMax} — addresses CI failure on PR #${input.prNumber}.

Co-authored-by: cezar-autofix <noreply@cezar>
`;
}

function buildCiFollowupPrComment(
  input: CiFollowupInput,
  fixReport: FixReport,
  verdict: Required<ReviewVerdict>,
): string {
  const files = fixReport.changedFiles.length > 0
    ? fixReport.changedFiles.map(f => `- \`${f}\``).join('\n')
    : '_(none reported)_';
  const tests = fixReport.testCommandsRun.length > 0
    ? fixReport.testCommandsRun.map(c => `- \`${c}\``).join('\n')
    : '_(none)_';
  const focus = input.attribution.suggestedFocus ? `\n**Focus:** ${input.attribution.suggestedFocus}` : '';
  return `## 🤖 Cezar CI follow-up (attempt ${input.attemptIndex}/${input.attemptMax})

Cezar re-ran against the failing CI and pushed an adjustment.${focus}

**Targeted failing checks:** ${input.failedCheckNames.join(', ') || '_(none listed)_'}

**Approach:** ${fixReport.approach}

**Files changed:**
${files}

**Verification:**
${tests}

**Automated review:** \`${verdict.verdict}\`
${verdict.summary}

A human reviewer should still confirm correctness before merge.`;
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

