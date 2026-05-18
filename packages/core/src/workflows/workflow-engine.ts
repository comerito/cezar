import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Config } from '../config/config.model.js';
import type { IssueStore } from '../store/store.js';
import type { AgentBackend, AgentEvent, AgentRunner, AgentRunSpec } from '../agents/agent-runner.js';
import { createAgentRunner } from '../agents/runner-factory.js';
import { discoverSkills, type Skill } from '../skills/skill-catalog.js';
import { resolveStepConfig, type WorkflowBinding, type WorkspaceWorkflowSettings, DEFAULT_WORKSPACE_WORKFLOW_SETTINGS } from './binding.js';
import { commitAll, getDiffAgainstBase, startWorktreeAutosaver } from '../actions/autofix/worktree.js';
import { PersistentClaudeSession } from '../agents/persistent-claude-session.js';
import { UNIFIED_AUTOFIX_SYSTEM_PROMPT } from '../actions/autofix/prompts/autofix-unified.js';
import { TokenBudget } from '../actions/autofix/token-budget.js';
import { parseStructured } from '../agents/structured-output.js';
import {
  type Workflow,
  type WorkflowStep,
  type WorkflowStepContext,
  type WorkflowRunResult,
  type WorkflowRunStatus,
  type StepRunStatus,
  type StepOutcome,
  type AgentRunRecord,
  type AgentStepDef,
  type CommentSection,
  type CommentTarget,
  type HumanGatePrompt,
  type HumanGateDecision,
  type WorkflowEffectDeps,
  type StepValue,
} from './workflow.js';

/** Resolve a `StepValue<T>` against the run's config (a fixed value or a `(config) => T`). */
function resolveStepValue<T>(value: StepValue<T>, config: Config): T {
  return typeof value === 'function' ? (value as (c: Config) => T)(config) : value;
}

/**
 * What the engine needs to drive a single workflow run. The caller (Phase 3:
 * the job dispatcher; today: tests / a thin CLI command) owns worktree setup
 * for repo-backed workflows — either pass `worktreePath` directly or supply
 * `prepareWorktree`.
 */
export interface WorkflowRunContext {
  store: IssueStore;
  config: Config;
  /** GitHub side. Structurally compatible with `GitHubService`; injectable for tests. */
  github: WorkflowGitHub;
  issueNumber: number;
  prNumber?: number;
  branch?: string;
  /** Picks the `AgentRunner` for a backend. Defaults to `createAgentRunner`. */
  runnerFactory?: (backend: AgentBackend) => AgentRunner;
  /** GUI-editable per-step bindings (from `config.workflow?.bindings`). */
  bindings?: WorkflowBinding[];
  settings?: WorkspaceWorkflowSettings;
  /** false ⇒ dry-run (no push, no PR). */
  apply: boolean;
  /** Pre-prepared worktree path for repo-backed workflows. */
  worktreePath?: string;
  /** Or: a hook the engine calls to set one up (and dispose it at the end). */
  prepareWorktree?: () => Promise<{ path: string; dispose: () => Promise<void> }>;
  /** Per-attempt token budget; created fresh per loop iteration if omitted. */
  tokenBudgetPerAttempt?: number;
  /** Lifecycle progress strings. */
  onEvent?: (event: string) => void;
  /** Normalized agent stream. */
  onAgentEvent?: (event: AgentEvent) => void;
  /** Phase 3 hook: persist each step's run record. */
  onRunRecord?: (record: AgentRunRecord) => void;
  /** Human-in-the-loop callback for `human-gate` steps; absent ⇒ pause cleanly unless `autoProceed`. */
  requestHumanDecision?: (prompt: HumanGatePrompt) => Promise<HumanGateDecision | null>;
  /** Pre-discovered repo skills; defaults to discovering from `config.autofix.repoRoot`. */
  skills?: Skill[];
  /**
   * Set to request a graceful pause between steps (docs §3.4). May be a static
   * boolean or a (sync/async) probe — the dispatcher passes a function that
   * re-reads the DB so an out-of-band pause request is honoured mid-run.
   * A running step is NOT interrupted mid-flight (known limitation, §3.4).
   */
  pauseRequested?: boolean | (() => boolean | Promise<boolean>);
  /**
   * Set to request cancellation between steps. Same shape/semantics as
   * `pauseRequested`, but ends the run `cancelled` (with `reason: 'cancelled'`).
   */
  cancelRequested?: boolean | (() => boolean | Promise<boolean>);
  /** Per-loop-id `maxIterations` override (workflow defs are static; config drives the cap). */
  loopMaxIterations?: Record<string, number>;
  /** Git ops in the worktree — injectable for tests; defaults to the real `worktree.ts` helpers. */
  gitOps?: {
    commitAll(worktreePath: string, message: string): Promise<string | null>;
    getDiffAgainstBase(worktreePath: string, baseRef: string): Promise<string>;
  };
}

/** The subset of `GitHubService` the engine touches. */
export interface WorkflowGitHub {
  addComment(issueNumber: number, body: string): Promise<number | void>;
  updateComment(commentId: number, body: string): Promise<void>;
  getIssueWithComments(issueNumber: number): Promise<{
    issue: { number: number; title: string; body: string };
    comments: Array<{ author: string; body: string; createdAt: string }>;
  }>;
  setLabels(issueNumber: number, labels: string[]): Promise<void>;
  addLabel(issueNumber: number, label: string): Promise<void>;
  closeIssue(issueNumber: number, reason?: 'completed' | 'not_planned'): Promise<void>;
  pushBranch(branch: string, localRepoPath: string, remote?: string): Promise<void>;
  createPullRequest(opts: { title: string; body: string; head: string; base: string; draft?: boolean; labels?: string[] }): Promise<{ url: string; number: number }>;
}

interface RenderedSection {
  stepId: string;
  heading: string;
  body: string;
}

type FinalOpts = { done: boolean; prNumber?: number; prUrl?: string; reason?: string };

/** Tracks the run's living comment(s) and renders the per-step checklist (docs §3.6). */
class LivingComment {
  private commentIds = new Map<CommentTarget, number>();
  private sections = new Map<CommentTarget, RenderedSection[]>();
  private active: CommentTarget;
  /** Set once the PR exists (so a 'pr'-first workflow can post on start). */
  private prNumber?: number;

  constructor(
    private readonly github: WorkflowGitHub,
    private readonly issueNumber: number,
    private readonly title: string,
    targetOrder: CommentTarget[],
    private readonly separatePerStep: boolean,
    prNumber?: number,
  ) {
    this.active = targetOrder[0] ?? 'issue';
    this.prNumber = prNumber;
  }

  private targetNumber(target: CommentTarget): number {
    return target === 'pr' && this.prNumber != null ? this.prNumber : this.issueNumber;
  }

  /** Post the initial "in progress" comment on the first target (if it exists). */
  async start(): Promise<void> {
    if (this.separatePerStep) return; // each section becomes its own comment instead
    if (this.active === 'pr' && this.prNumber == null) return; // PR not opened yet — wait for switchToPr
    const body = this.render(this.active, false);
    const id = await this.github.addComment(this.targetNumber(this.active), body);
    if (typeof id === 'number') this.commentIds.set(this.active, id);
  }

  async appendSection(stepId: string, section: CommentSection): Promise<void> {
    if (!section) return;
    if (this.separatePerStep) {
      // Old behavior: one comment per step.
      await this.github.addComment(this.targetNumber(this.active), `### ${section.heading}\n\n${section.body}`);
      return;
    }
    const list = this.sections.get(this.active) ?? [];
    list.push({ stepId, heading: section.heading, body: section.body });
    this.sections.set(this.active, list);
    if (this.commentIds.has(this.active)) await this.rerender(this.active);
    // else: no comment to edit yet (e.g. PR-first workflow before the PR is
    // opened) — the sections are buffered and emitted when start()/switchToPr fires.
  }

  /** Switch the living comment to the PR (post a fresh single comment there). */
  async switchToPr(prNumber: number): Promise<void> {
    this.prNumber = prNumber;
    this.active = 'pr';
    if (this.separatePerStep) return;
    if (!this.commentIds.has('pr')) {
      const body = this.render('pr', false);
      const id = await this.github.addComment(prNumber, body);
      if (typeof id === 'number') this.commentIds.set('pr', id);
    } else {
      await this.rerender('pr');
    }
  }

  /** Finalize: re-render every comment with the final status; link the issue comment to the PR. */
  async finalize(opts: FinalOpts): Promise<void> {
    if (this.separatePerStep) return;
    for (const target of this.commentIds.keys()) {
      await this.rerender(target, opts);
    }
  }

  private async rerender(target: CommentTarget, finalOpts?: FinalOpts): Promise<void> {
    const id = this.commentIds.get(target);
    if (id == null) return;
    const body = this.render(target, true, finalOpts);
    try {
      await this.github.updateComment(id, body);
    } catch {
      // Editing the living comment is best-effort — the step results are the
      // source of truth, not the comment.
    }
  }

  private render(target: CommentTarget, started: boolean, finalOpts?: FinalOpts): string {
    const list = this.sections.get(target) ?? [];
    const header = target === 'pr'
      ? `## 🤖 Cezar — automated work for #${this.issueNumber}`
      : `## 🤖 Cezar autofix — ${finalOpts?.done ? 'done' : 'in progress'}`;
    const lines: string[] = [header, '', `**Issue:** #${this.issueNumber} — ${this.title}`, ''];
    if (list.length === 0) {
      lines.push(started ? '_(no sections yet)_' : '_Starting…_');
    } else {
      for (const s of list) {
        lines.push(`### ${s.heading}`, '', s.body, '');
      }
    }
    if (finalOpts?.done && target === 'issue') {
      if (finalOpts.prNumber != null) {
        lines.push('---', `Done — see PR #${finalOpts.prNumber}${finalOpts.prUrl ? ` (${finalOpts.prUrl})` : ''}.`);
      } else if (finalOpts.reason) {
        lines.push('---', `Done — ${finalOpts.reason}`);
      } else {
        lines.push('---', 'Done.');
      }
    }
    return lines.join('\n');
  }
}

/** Execute one declarative workflow run. */
export class WorkflowEngine {
  async runWorkflow<W>(workflow: Workflow<W>, ctx: WorkflowRunContext): Promise<WorkflowRunResult<W>> {
    const settings: WorkspaceWorkflowSettings = ctx.settings ?? DEFAULT_WORKSPACE_WORKFLOW_SETTINGS;
    const runnerFactory = ctx.runnerFactory ?? ((backend) => createAgentRunner(backend, { config: ctx.config }));
    const bindings = ctx.bindings ?? ctx.config.workflow?.bindings ?? [];

    // Issue data — repo-less workflows still want title/body for prompts.
    let issueTitle = `#${ctx.issueNumber}`;
    let issueBody = '';
    let issueComments: Array<{ author: string; body: string; createdAt: string }> = [];
    try {
      const data = await ctx.github.getIssueWithComments(ctx.issueNumber);
      issueTitle = data.issue.title;
      issueBody = data.issue.body;
      issueComments = data.comments;
    } catch (err) {
      ctx.onEvent?.(`[#${ctx.issueNumber}] could not fetch issue data: ${(err as Error).message}`);
    }

    const storedIssue = ctx.store.getIssue(ctx.issueNumber);
    const digest = storedIssue?.digest
      ? { summary: storedIssue.digest.summary, affectedArea: storedIssue.digest.affectedArea, keywords: storedIssue.digest.keywords }
      : undefined;

    const skills: Skill[] = ctx.skills ?? await this.discoverSkillsSafe(ctx);

    // Worktree (repo-backed workflows). The caller may pass a path directly or
    // a `prepareWorktree` hook; repo-less workflows leave both undefined.
    let worktreePath = ctx.worktreePath;
    let disposeWorktree: (() => Promise<void>) | undefined;
    if (!worktreePath && ctx.prepareWorktree) {
      const wt = await ctx.prepareWorktree();
      worktreePath = wt.path;
      disposeWorktree = wt.dispose;
    }

    const blackboard = workflow.initialBlackboard();
    const runRecords: AgentRunRecord[] = [];
    let totalTokens = 0;
    let branch = ctx.branch;
    let headSha: string | undefined;
    let prUrl: string | undefined;
    let prNumber = ctx.prNumber;

    // Phase B: unified persistent session for autofix.
    // Per docs/REFACTOR-PLAN-persistent-autofix-session.md §5 Phase B.
    // Only applies when ALL of:
    //   - this is the autofix workflow (the only one with the 4-role shape)
    //   - config.autofix.runner.mode === 'unified'
    //   - we have a worktree
    // Otherwise stays staged (today's behavior; one process per step).
    const unifiedSession = await this.maybeStartUnifiedSession({
      workflowId: workflow.id,
      config: ctx.config,
      worktreePath,
      onEvent: ctx.onAgentEvent,
    });

    const living = new LivingComment(
      ctx.github,
      ctx.issueNumber,
      issueTitle,
      workflow.commentTargetOrder,
      settings.separateCommentPerStep,
      ctx.prNumber,
    );

    const gitOps = ctx.gitOps ?? { commitAll, getDiffAgainstBase };

    const effectDeps: WorkflowEffectDeps = {
      github: {
        addComment: (n, b) => ctx.github.addComment(n, b),
        updateComment: (id, b) => ctx.github.updateComment(id, b),
        setLabels: (n, l) => ctx.github.setLabels(n, l),
        addLabel: (n, l) => ctx.github.addLabel(n, l),
        closeIssue: (n, r) => ctx.github.closeIssue(n, r),
        pushBranch: (br, p, r) => ctx.github.pushBranch(br, p, r),
        createPullRequest: (o) => ctx.github.createPullRequest(o),
      },
      git: gitOps,
      store: ctx.store,
    };

    const finishRun = async (
      status: WorkflowRunStatus,
      reason?: string,
    ): Promise<WorkflowRunResult<W>> => {
      // Stop the unified session FIRST — its child needs the worktree
      // path to still exist for any pending flushes. (dispose may remove it.)
      if (unifiedSession) {
        await unifiedSession.stop().catch((err) => {
          ctx.onEvent?.(`[#${ctx.issueNumber}] unified session stop failed: ${(err as Error).message}`);
        });
      }
      if (disposeWorktree) await disposeWorktree().catch(() => {});
      await living.finalize({
        done: status === 'succeeded',
        prNumber,
        prUrl,
        reason,
      });
      return {
        status,
        blackboard,
        runRecords,
        reason,
        prUrl,
        prNumber,
        branch,
        headSha,
        tokensUsed: totalTokens,
      };
    };

    await living.start();
    ctx.onEvent?.(`[#${ctx.issueNumber}] workflow '${workflow.id}' — ${workflow.steps.length} step(s)`);

    // Build a quick lookup for which loop (if any) a step belongs to. Apply
    // any `loopMaxIterations` override (workflow defs are static; config caps it).
    const effectiveLoops = (workflow.loops ?? []).map((loop) => {
      const override = ctx.loopMaxIterations?.[loop.id];
      const maxIterations = override != null ? Math.max(1, override) : loop.maxIterations;
      return { ...loop, maxIterations };
    });
    const loopById = new Map(effectiveLoops.map((l) => [l.id, l]));
    const loopOfStep = new Map<string, typeof effectiveLoops[number]>();
    for (const loop of effectiveLoops) {
      for (const sid of loop.stepIds) loopOfStep.set(sid, loop);
    }

    // Engine main loop. We walk `workflow.steps` by index; when a loop body
    // step fails-retriable (or returns goto-loop) we jump the cursor back to
    // the loop's first step and bump the iteration counter.
    const resolveFlag = async (flag: WorkflowRunContext['pauseRequested']): Promise<boolean> => {
      if (flag == null) return false;
      if (typeof flag === 'boolean') return flag;
      return (await flag()) === true;
    };

    let i = 0;
    const loopIterations = new Map<string, number>();
    while (i < workflow.steps.length) {
      if (await resolveFlag(ctx.cancelRequested)) {
        return finishRun('cancelled', 'cancelled');
      }
      if (await resolveFlag(ctx.pauseRequested)) {
        return finishRun('paused', 'paused — pause requested between steps');
      }
      const step = workflow.steps[i];
      const loop = loopOfStep.get(step.id);
      const iteration = loop ? (loopIterations.get(loop.id) ?? 0) : 0;

      // Skip open-pr when not applying.
      if (step.kind === 'open-pr' && !ctx.apply) {
        ctx.onEvent?.(`[#${ctx.issueNumber}] DRY-RUN — skipping ${step.id}`);
        i++;
        continue;
      }

      const stepCtx = this.makeStepContext<W>({
        blackboard, iteration, config: ctx.config,
        issue: { number: ctx.issueNumber, title: issueTitle, body: issueBody, comments: issueComments, digest },
        prNumber, branch, worktreePath,
        tokenBudget: undefined, // set per agent step below
        onAgentEvent: ctx.onAgentEvent, onEvent: ctx.onEvent,
        appendCommentSection: (section) => living.appendSection(step.id, section),
        requestHumanDecision: ctx.requestHumanDecision,
      });

      let outcome: StepOutcome<W>;
      let record: AgentRunRecord | undefined;

      try {
        if (step.kind === 'agent') {
          const r = await this.runAgentStep(step as AgentStepDef<W, unknown>, {
            stepCtx, iteration, bindings, skills, runnerFactory,
            tokenBudgetPerAttempt: ctx.tokenBudgetPerAttempt ?? ctx.config.autofix?.tokenBudgetPerAttempt,
            workflowId: workflow.id, worktreePath,
            living,
            unifiedSession,
          });
          outcome = r.outcome;
          record = r.record;
          totalTokens += r.record.tokensUsed;
        } else if (step.kind === 'effect') {
          outcome = await step.run(stepCtx, effectDeps);
          if (step.commentSection) await living.appendSection(step.id, step.commentSection(stepCtx));
        } else if (step.kind === 'human-gate') {
          const r = await this.runHumanGate(step, stepCtx);
          if (r.kind === 'paused') {
            return finishRun('paused', `paused — awaiting human decision at '${step.id}'`);
          }
          outcome = r.outcome;
          if (step.commentSection) await living.appendSection(step.id, step.commentSection(stepCtx));
        } else if (step.kind === 'commit') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const message = step.buildMessage(stepCtx);
          const sha = await gitOps.commitAll(wt, message);
          if (!sha) {
            if (step.failOnNoChanges) {
              outcome = { kind: 'fail', reason: 'fixer made no file changes' };
            } else {
              outcome = { kind: 'skip-run', reason: 'fixer made no file changes — CI failure may no longer reproduce' };
            }
          } else {
            const diff = await gitOps.getDiffAgainstBase(wt, ctx.config.autofix?.baseBranch ?? 'main');
            headSha = sha;
            outcome = step.onCommitted({ commitSha: sha, diff }, stepCtx);
            if (step.commentSection) await living.appendSection(step.id, step.commentSection({ commitSha: sha }, stepCtx));
          }
        } else if (step.kind === 'open-pr') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const cfg = ctx.config.autofix;
          const pushBranchName = (cfg?.branchPrefix ?? 'autofix/cezar-issue-') + ctx.issueNumber;
          await ctx.github.pushBranch(pushBranchName, wt, cfg?.remote);
          const { title, body } = step.buildPr(stepCtx);
          const pr = await ctx.github.createPullRequest({
            title, body,
            head: pushBranchName,
            base: cfg?.baseBranch ?? 'main',
            draft: cfg?.draftPr ?? true,
            labels: cfg?.prLabels,
          });
          prUrl = pr.url;
          prNumber = pr.number;
          branch = pushBranchName;
          // Post-PR steps edit the PR comment now.
          await living.switchToPr(pr.number);
          if (step.prCommentSection) await living.appendSection(step.id, step.prCommentSection(stepCtx));
          outcome = step.onOpened({ url: pr.url, number: pr.number, headSha: headSha ?? '' }, stepCtx);
        } else if (step.kind === 'push') {
          const wt = this.requireWorktree(worktreePath, step.id);
          const cfg = ctx.config.autofix;
          if (!branch) {
            outcome = { kind: 'fail', reason: `push step '${step.id}' has no branch to push` };
          } else {
            await ctx.github.pushBranch(branch, wt, cfg?.remote);
            if (prNumber != null) {
              await living.switchToPr(prNumber);
              if (step.prCommentSection) await living.appendSection(step.id, step.prCommentSection(stepCtx));
            }
            outcome = step.onPushed({ headSha: headSha ?? '' }, stepCtx);
          }
        } else {
          const exhaustive: never = step;
          throw new Error(`unknown step kind: ${JSON.stringify(exhaustive)}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (record) {
          record.status = 'failed';
          record.error = msg;
          record.finishedAt = new Date().toISOString();
          ctx.onRunRecord?.(record);
        }
        return finishRun('failed', `step '${step.id}' threw: ${msg}`);
      }

      // Record the step (non-agent steps get a synthetic record too so the
      // cockpit shows every step; agent steps already have theirs).
      if (!record) {
        record = this.syntheticRecord(workflow.id, step.id, step.kind, iteration, 'succeeded');
      }
      if (outcome.kind === 'skip-run') {
        record.status = 'skipped';
        record.summary = outcome.reason;
      } else if (outcome.kind === 'fail') {
        record.status = 'failed';
        record.error = outcome.reason;
      }
      record.finishedAt ??= new Date().toISOString();
      runRecords.push(record);
      ctx.onRunRecord?.(record);

      // Apply blackboard patch (continue / goto-loop / fail-retriable can carry one).
      if ('blackboardPatch' in outcome && outcome.blackboardPatch) {
        Object.assign(blackboard as object, outcome.blackboardPatch);
      }

      // ── Outcome dispatch ──
      if (outcome.kind === 'skip-run') {
        return finishRun('succeeded', outcome.reason);
      }

      if (outcome.kind === 'fail') {
        const retriable = outcome.retriable === true && loop != null;
        if (!retriable) {
          return finishRun('failed', outcome.reason);
        }
        // Retry the loop.
        const next = (loopIterations.get(loop.id) ?? 0) + 1;
        if (next >= loop.maxIterations) {
          return finishRun('failed', `${outcome.reason} (loop '${loop.id}' exhausted ${loop.maxIterations} iteration(s))`);
        }
        loopIterations.set(loop.id, next);
        ctx.onEvent?.(`[#${ctx.issueNumber}] loop '${loop.id}' — retry ${next}/${loop.maxIterations}: ${outcome.reason}`);
        i = workflow.steps.findIndex((s) => s.id === loop.stepIds[0]);
        continue;
      }

      if (outcome.kind === 'goto-loop') {
        const targetLoop = loopById.get(outcome.loopId);
        if (!targetLoop) return finishRun('failed', `goto-loop to unknown loop '${outcome.loopId}'`);
        const next = (loopIterations.get(targetLoop.id) ?? 0) + 1;
        if (next >= targetLoop.maxIterations) {
          return finishRun('failed', `loop '${targetLoop.id}' exhausted ${targetLoop.maxIterations} iteration(s)`);
        }
        loopIterations.set(targetLoop.id, next);
        i = workflow.steps.findIndex((s) => s.id === targetLoop.stepIds[0]);
        continue;
      }

      // continue — but if this was the last step of a loop, check `until`.
      if (loop && step.id === loop.stepIds[loop.stepIds.length - 1]) {
        const done = loop.until(stepCtx);
        if (!done) {
          const next = (loopIterations.get(loop.id) ?? 0) + 1;
          if (next >= loop.maxIterations) {
            return finishRun('failed', `loop '${loop.id}' exhausted ${loop.maxIterations} iteration(s) without satisfying its exit condition`);
          }
          loopIterations.set(loop.id, next);
          ctx.onEvent?.(`[#${ctx.issueNumber}] loop '${loop.id}' — iteration ${next}/${loop.maxIterations}`);
          i = workflow.steps.findIndex((s) => s.id === loop.stepIds[0]);
          continue;
        }
      }

      i++;
    }

    return finishRun('succeeded');
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private requireWorktree(path: string | undefined, stepId: string): string {
    if (!path) throw new Error(`step '${stepId}' requires a worktree but none was provided`);
    return path;
  }

  private async discoverSkillsSafe(ctx: WorkflowRunContext): Promise<Skill[]> {
    const repoRoot = ctx.config.autofix?.repoRoot;
    if (!repoRoot) return [];
    try {
      return await discoverSkills(resolve(repoRoot), ctx.config.autofix?.skillsDir ?? '.ai/skills');
    } catch (err) {
      ctx.onEvent?.(`[#${ctx.issueNumber}] SKILLS — discovery failed, continuing with built-in prompts (${(err as Error).message})`);
      return [];
    }
  }

  private makeStepContext<W>(args: {
    blackboard: W;
    iteration: number;
    config: Config;
    issue: WorkflowStepContext<W>['issue'];
    prNumber?: number;
    branch?: string;
    worktreePath?: string;
    tokenBudget?: TokenBudget;
    onAgentEvent?: (e: AgentEvent) => void;
    onEvent?: (e: string) => void;
    appendCommentSection: (section: CommentSection) => Promise<void>;
    requestHumanDecision?: (prompt: HumanGatePrompt) => Promise<HumanGateDecision | null>;
  }): WorkflowStepContext<W> {
    return {
      blackboard: args.blackboard,
      iteration: args.iteration,
      config: args.config,
      issue: args.issue,
      prNumber: args.prNumber,
      branch: args.branch,
      worktreePath: args.worktreePath,
      tokenBudget: args.tokenBudget,
      emit: (e) => args.onAgentEvent?.(e),
      log: (m) => args.onEvent?.(m),
      appendCommentSection: args.appendCommentSection,
      requestHumanDecision: async (prompt) => (args.requestHumanDecision ? args.requestHumanDecision(prompt) : null),
    };
  }

  private syntheticRecord(workflow: string, stepId: string, kind: AgentRunRecord['kind'], iteration: number, status: StepRunStatus): AgentRunRecord {
    return {
      id: randomUUID(),
      workflow,
      stepId,
      kind,
      iteration,
      backend: 'anthropic-api',
      model: '(none)',
      status,
      startedAt: new Date().toISOString(),
      tokensUsed: 0,
    };
  }

  private async runHumanGate<W>(
    step: Extract<WorkflowStep<W>, { kind: 'human-gate' }>,
    ctx: WorkflowStepContext<W>,
  ): Promise<{ kind: 'paused' } | { kind: 'resolved'; outcome: StepOutcome<W> }> {
    if (step.autoProceed?.(ctx)) {
      return { kind: 'resolved', outcome: { kind: 'continue' } };
    }
    // Phase C (TODO — see docs/REFACTOR-PLAN-persistent-autofix-session.md §5
    // "Phase C"): in unified mode, a paused gate should keep the
    // PersistentClaudeSession's child alive so resume can pick up
    // mid-conversation with the cache prefix intact. Today we still
    // return `paused`; the workflow_runs row is paused, the runner
    // process exits, and a resume re-spawns a fresh session (same as
    // staged). Wiring up the alive-child path requires:
    //   1. A Supabase channel subscription here that resolves on
    //      'resume' or 'cancel' broadcasts for this workflow_run.id.
    //   2. Keeping the parent runner process alive for the whole pause
    //      duration (today the dispatch worker is short-lived).
    //   3. A heartbeat/keepalive on the child every ~5 min so the SDK
    //      doesn't time out.
    // Left as the next PR's work — staged mode handles the gate just
    // fine while the rest of Phase B settles.
    const prompt = step.buildPrompt(ctx);
    const decision = await ctx.requestHumanDecision(prompt);
    if (!decision) return { kind: 'paused' };
    const outcome = step.onDecision
      ? step.onDecision(decision, ctx)
      : (decision.choice === 'proceed'
        ? ({ kind: 'continue' } as StepOutcome<W>)
        : ({ kind: 'skip-run', reason: `human chose '${decision.choice}'` } as StepOutcome<W>));
    return { kind: 'resolved', outcome };
  }

  private async runAgentStep<W>(
    step: AgentStepDef<W, unknown>,
    args: {
      stepCtx: WorkflowStepContext<W>;
      iteration: number;
      bindings: WorkflowBinding[];
      skills: Skill[];
      runnerFactory: (backend: AgentBackend) => AgentRunner;
      tokenBudgetPerAttempt?: number;
      workflowId: string;
      worktreePath?: string;
      living: LivingComment;
      /** Phase B: when set, the engine routes agent steps through this
       *  long-lived session instead of spawning a fresh `claude` per step. */
      unifiedSession: PersistentClaudeSession | null;
    },
  ): Promise<{ outcome: StepOutcome<W>; record: AgentRunRecord }> {
    const { stepCtx, iteration, bindings, skills, runnerFactory, workflowId } = args;

    if (step.cwdRequired && !args.worktreePath) {
      throw new Error(`agent step '${step.id}' requires a worktree but none was provided`);
    }

    const config = stepCtx.config;
    const builtinModel = resolveStepValue(step.builtinModel, config);
    const builtinTools = resolveStepValue(step.builtinTools, config);
    const bashAllowlist = step.bashAllowlist != null ? resolveStepValue(step.bashAllowlist, config) : undefined;
    const maxTurns = step.maxTurns != null ? resolveStepValue(step.maxTurns, config) : undefined;

    const resolved = resolveStepConfig({
      stepId: step.id,
      builtinSystemPrompt: step.builtinSystemPrompt,
      builtinModel,
      binding: bindings.find((b) => b.stepId === step.id),
      skills,
    });

    const budget = args.tokenBudgetPerAttempt ? new TokenBudget(args.tokenBudgetPerAttempt) : undefined;
    const ctxWithBudget: WorkflowStepContext<W> = { ...stepCtx, tokenBudget: budget };

    const record: AgentRunRecord = {
      id: randomUUID(),
      workflow: workflowId,
      stepId: step.id,
      kind: 'agent',
      iteration,
      backend: resolved.backend,
      model: resolved.model,
      status: 'running',
      startedAt: new Date().toISOString(),
      tokensUsed: 0,
    };

    const runner = runnerFactory(resolved.backend);
    const allowedTools = [...builtinTools, ...resolved.extraTools];
    const spec: AgentRunSpec<unknown> = {
      systemPrompt: resolved.systemPrompt,
      userPrompt: step.buildUserPrompt(ctxWithBudget),
      cwd: args.worktreePath ?? process.cwd(),
      allowedTools,
      bashAllowlist,
      model: resolved.model,
      maxTurns,
      tokenBudget: budget,
      responseSchema: step.responseSchema,
      // Use the agent_runs row id as the claude session id so an operator
      // can `cd <worktree> && claude --resume <id>` after a failed run.
      // Only honored by ClaudeCodeCliRunner today — see agent-runner.ts.
      sessionId: record.id,
    };

    // Periodic autosave for steps that can mutate the worktree (fixer-class).
    // A crashed agent leaves a recoverable branch instead of an empty run.
    const writeTools = new Set(['Edit', 'Write', 'NotebookEdit']);
    const mutates = allowedTools.some((t) => writeTools.has(t));
    const stopAutosave = mutates && args.worktreePath
      ? startWorktreeAutosaver({
          worktreePath: args.worktreePath,
          message: `cezar: autosave (${step.id})`,
          onWarn: (m) => stepCtx.emit({ type: 'note', message: m }),
        })
      : null;

    let result: Awaited<ReturnType<typeof runner.run>>;
    try {
      if (args.unifiedSession) {
        // Phase B: route through the persistent session. The unified
        // system prompt was set once when the session started; here we
        // send the step's user prompt with a phase marker and let the
        // session return the assistant text + per-phase token delta.
        const phaseResult = await args.unifiedSession.sendPhase(step.id, spec.userPrompt);
        result = {
          text: phaseResult.text,
          parsed: null,
          toolCalls: phaseResult.toolCalls,
          tokensUsed: phaseResult.tokensUsed,
          budgetExceeded: false,
        };
      } else {
        result = await runner.run(spec, (e) => stepCtx.emit(e));
      }
    } finally {
      if (stopAutosave) await stopAutosave();
    }
    record.tokensUsed = result.tokensUsed;
    record.finishedAt = new Date().toISOString();

    if (result.budgetExceeded) {
      record.status = 'failed';
      record.error = `token budget exceeded during '${step.id}'`;
      if (step.failCommentSection) await args.living.appendSection(step.id, step.failCommentSection(record.error, stepCtx));
      return { outcome: { kind: 'fail', reason: record.error }, record };
    }

    // The runner extracts structured output, but fall back to parseStructured
    // on the raw text (mirrors the orchestrator's recovery behavior).
    const parsed = result.parsed ?? parseStructured(result.text, step.responseSchema);
    if (parsed == null) {
      if (step.onNoParse) {
        const outcome = step.onNoParse(result.text, stepCtx);
        record.status = outcome.kind === 'fail' ? 'failed' : outcome.kind === 'skip-run' ? 'skipped' : 'succeeded';
        if (outcome.kind === 'fail') record.error = outcome.reason;
        if (step.failCommentSection && outcome.kind === 'fail') {
          await args.living.appendSection(step.id, step.failCommentSection(outcome.reason, stepCtx));
        }
        return { outcome, record };
      }
      const tail = result.text.slice(-400).trim();
      const reason = tail
        ? `${step.id} did not return a valid JSON response. Last output: "${tail}"`
        : `${step.id} returned no parseable output (likely hit maxTurns without emitting JSON)`;
      record.status = 'failed';
      record.error = reason;
      if (step.failCommentSection) await args.living.appendSection(step.id, step.failCommentSection(reason, stepCtx));
      return { outcome: { kind: 'fail', reason }, record };
    }

    const outcome = step.onResult(parsed, stepCtx);
    record.status = outcome.kind === 'fail' ? 'failed' : outcome.kind === 'skip-run' ? 'skipped' : 'succeeded';
    if (outcome.kind === 'fail') record.error = outcome.reason;
    if (outcome.kind === 'skip-run') record.summary = outcome.reason;

    if (outcome.kind === 'fail') {
      if (step.failCommentSection) await args.living.appendSection(step.id, step.failCommentSection(outcome.reason, stepCtx));
    } else if (step.commentSection) {
      await args.living.appendSection(step.id, step.commentSection(parsed, stepCtx));
    }

    return { outcome, record };
  }

  /**
   * Start a unified `PersistentClaudeSession` for the autofix workflow
   * when the workspace has opted in via `config.autofix.runner.mode`.
   * Returns `null` otherwise — staged mode keeps today's behavior.
   *
   * Gates (per docs/REFACTOR-PLAN-persistent-autofix-session.md §5/§7):
   *   • workflow.id === 'autofix' (only workflow with the 4-role shape)
   *   • config.autofix.runner.mode === 'unified'
   *   • a worktree is available (claude needs cwd)
   *
   * Backend lock (Q4) is enforced in the runner factory — by the time
   * this method is called the workspace is already in CLI territory.
   */
  private async maybeStartUnifiedSession(args: {
    workflowId: string;
    config: Config;
    worktreePath: string | undefined;
    onEvent: ((evt: AgentEvent) => void) | undefined;
  }): Promise<PersistentClaudeSession | null> {
    if (args.workflowId !== 'autofix') return null;
    if (args.config.autofix?.runner?.mode !== 'unified') return null;
    if (!args.worktreePath) return null;
    const sessionId = randomUUID();
    const session = new PersistentClaudeSession({
      systemPrompt: UNIFIED_AUTOFIX_SYSTEM_PROMPT,
      sessionId,
      cwd: args.worktreePath,
      model: args.config.autofix?.models?.analyzer,
      // Unified mode pools the analyzer/fixer/reviewer tool budgets;
      // the agent decides per phase which tools to invoke from this
      // union. Read + write are both allowed since fixer needs them.
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash'],
      bashAllowlist: args.config.autofix?.bashAllowlist,
      onEvent: (e) => {
        // Forward to the same agent-event sink the staged path uses so
        // the cockpit doesn't need to know which mode produced an event.
        args.onEvent?.(e);
      },
    });
    session.start();
    return session;
  }
}

/** Functional sugar — `runWorkflow(workflow, ctx)` ≡ `new WorkflowEngine().runWorkflow(...)`. */
export function runWorkflow<W>(workflow: Workflow<W>, ctx: WorkflowRunContext): Promise<WorkflowRunResult<W>> {
  return new WorkflowEngine().runWorkflow(workflow, ctx);
}
