import type { z } from 'zod';
import type { AgentBackend, AgentEvent } from '../agents/agent-runner.js';
import type { Config } from '../config/config.model.js';
import type { TokenBudget } from '../actions/autofix/token-budget.js';

/**
 * The declarative workflow types (docs/REFACTOR-PLAN-agent-cockpit.md §3.1).
 * A `Workflow<W>` is a sequence of typed steps that mutate a per-workflow
 * "blackboard" `W` (the structured outputs accumulated so far). `WorkflowEngine`
 * (./workflow-engine.ts) executes them. Phase 2 lands this engine *alongside*
 * the legacy `AutofixOrchestrator`; the cutover (orchestrator → thin adapter)
 * is Phase 3.
 *
 * Naming note (Phase 0 §6): this module consumes the *normalized* runner
 * `AgentEvent` (from `../agents/agent-runner.js`) — the one re-exported from
 * `@cezar/core` as `RunnerAgentEvent`. The legacy `event.port.ts` `AgentEvent`
 * is untouched (the CLI/GUI still depend on it).
 */

// ─── Run / step states (docs §3.4 — Phase 2 just *models* the states) ────────

export type WorkflowRunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';
export type StepRunStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export type WorkflowStepKind = 'agent' | 'effect' | 'human-gate' | 'commit' | 'open-pr' | 'push';

// ─── Comment helpers passed to a step ────────────────────────────────────────

export type CommentTarget = 'issue' | 'pr';

/** A rendered section of the run's living comment (docs §3.6). `null` ⇒ no section. */
export type CommentSection = { heading: string; body: string } | null;

// ─── Step outcomes ───────────────────────────────────────────────────────────

/**
 * What a step's `onResult` (agent steps) / `run` (effect/commit/etc.) returns.
 *  - `continue` — apply `blackboardPatch`, advance.
 *  - `skip-run` — terminal: the whole workflow ends `succeeded`-but-skipped
 *    (e.g. verify-in-repo decided the issue is not a real defect). `reason`
 *    surfaces to the caller.
 *  - `fail` — terminal failure *unless* `retriable` and the step sits inside a
 *    declared loop, in which case the engine re-enters the loop (carrying any
 *    `blackboardPatch`, e.g. reviewer retry notes) up to `maxIterations`.
 *  - `goto-loop` — explicit jump back to the start of a declared loop.
 */
export type StepOutcome<W> =
  | { kind: 'continue'; blackboardPatch?: Partial<W> }
  | { kind: 'skip-run'; reason: string }
  | { kind: 'fail'; reason: string; retriable?: boolean; blackboardPatch?: Partial<W> }
  | { kind: 'goto-loop'; loopId: string; blackboardPatch?: Partial<W> };

// ─── Step execution context ─────────────────────────────────────────────────

/**
 * The data + capabilities every step receives. Steps are pure-ish functions of
 * `(ctx) → (StepOutcome + side effects via ctx)`.
 */
export interface WorkflowStepContext<W> {
  /** The accumulated structured outputs (the blackboard). Read-only here; mutate via the returned `blackboardPatch`. */
  readonly blackboard: Readonly<W>;
  /** Iteration index of the enclosing loop (0 on the first pass, ≥1 on retries). 0 for non-loop steps. */
  readonly iteration: number;
  /** The resolved Cezar config. */
  readonly config: Config;
  /** The issue this run targets. */
  readonly issue: {
    number: number;
    title: string;
    body: string;
    comments: Array<{ author: string; body: string; createdAt: string }>;
    digest?: { summary: string; affectedArea: string; keywords: string[] };
  };
  /** When the workflow operates on a PR (ci-followup). */
  readonly prNumber?: number;
  readonly branch?: string;
  /** The git worktree path (autofix/ci-followup); undefined for repo-less workflows (triage). */
  readonly worktreePath?: string;
  /** Per-attempt token budget (autofix loop iterations get a fresh one). */
  readonly tokenBudget?: TokenBudget;
  /** Stream a normalized agent event (or a lifecycle note) out to the caller. */
  emit(event: AgentEvent): void;
  /** Lifecycle string (engine-side progress log). */
  log(message: string): void;
  /** Append a section to the run's living comment (docs §3.6). */
  appendCommentSection(section: CommentSection): Promise<void>;
  /**
   * Ask the human a question (human-gate steps). Returns the decision, or
   * `null` when no decision callback is wired AND the auto-proceed threshold
   * isn't met — the engine treats `null` as "pause cleanly".
   */
  requestHumanDecision(prompt: HumanGatePrompt): Promise<HumanGateDecision | null>;
}

export interface HumanGatePrompt {
  stepId: string;
  question: string;
  /** Allowed responses, e.g. `['proceed', 'skip']`. */
  options: string[];
  /** Extra structured context the frontend can render (e.g. the root cause). */
  context?: unknown;
}

export interface HumanGateDecision {
  choice: string;
}

// ─── Step definitions ───────────────────────────────────────────────────────

interface BaseStepDef {
  id: string;
  /** Built-in skill id this step's prompt embeds (`'verify-in-repo' | 'root-cause' | 'fix' | 'review' | …`). */
  builtinSkillId: string;
}

/** Either a fixed value or one derived from the resolved config (e.g. `cfg.autofix.allowedTools`). */
export type StepValue<T> = T | ((config: Config) => T);

/** An `agent` step: runs an `AgentRunner` with a step-owned response schema. */
export interface AgentStepDef<W, T> extends BaseStepDef {
  kind: 'agent';
  builtinSystemPrompt: string;
  /** Built-in model — config-derivable (today's `cfg.autofix.models.*`). */
  builtinModel: StepValue<string>;
  /** Tool allowlist — config-derivable (today's `cfg.autofix.allowedTools`). */
  builtinTools: StepValue<string[]>;
  /** When `Bash` is in `builtinTools`, restrict it to commands starting with one of these — config-derivable. */
  bashAllowlist?: StepValue<string[]>;
  /** Per-step turn cap — config-derivable (today's `cfg.maxTurns.*`). */
  maxTurns?: StepValue<number>;
  responseSchema: z.ZodSchema<T>;
  buildUserPrompt: (ctx: WorkflowStepContext<W>) => string;
  /** Map the parsed structured output onto a step outcome. */
  onResult: (parsed: T, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
  /** Recover a step outcome when the agent emitted no parseable output. */
  onNoParse?: (rawText: string, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
  /** Render this step's section of the living comment from the parsed output. */
  commentSection?: (parsed: T, ctx: WorkflowStepContext<W>) => CommentSection;
  /** Render a section when the step failed (no parse / outcome=fail). */
  failCommentSection?: (reason: string, ctx: WorkflowStepContext<W>) => CommentSection;
  /** True ⇒ the engine refuses to run this step without a `worktreePath`. */
  cwdRequired: boolean;
}

/** A side-effecting step (add label, comment, close issue, …) with typed I/O. */
export interface EffectStepDef<W> extends BaseStepDef {
  kind: 'effect';
  run: (ctx: WorkflowStepContext<W>, deps: WorkflowEffectDeps) => Promise<StepOutcome<W>>;
  commentSection?: (ctx: WorkflowStepContext<W>) => CommentSection;
}

/** A pause-for-a-decision step. */
export interface HumanGateStepDef<W> extends BaseStepDef {
  kind: 'human-gate';
  buildPrompt: (ctx: WorkflowStepContext<W>) => HumanGatePrompt;
  /** Map a decision onto an outcome. Default: `proceed` → continue, anything else → skip-run. */
  onDecision?: (decision: HumanGateDecision, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
  /**
   * Auto-proceed predicate: when no decision callback is wired, return `true`
   * to skip the gate (the confidence-threshold case). Default: never auto-proceed.
   */
  autoProceed?: (ctx: WorkflowStepContext<W>) => boolean;
  commentSection?: (ctx: WorkflowStepContext<W>) => CommentSection;
}

/** Stage all changes in the worktree and commit them. */
export interface CommitStepDef<W> extends BaseStepDef {
  kind: 'commit';
  buildMessage: (ctx: WorkflowStepContext<W>) => string;
  /** `true` ⇒ commit producing no changes is a hard fail (autofix); `false` ⇒ skip-run (ci-followup). */
  failOnNoChanges: boolean;
  /** Patch the blackboard with the commit sha + the diff against base. */
  onCommitted: (info: { commitSha: string; diff: string }, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
  commentSection?: (info: { commitSha: string }, ctx: WorkflowStepContext<W>) => CommentSection;
}

/** Push the branch and open a PR (autofix). Only runs when `apply` is true. */
export interface OpenPrStepDef<W> extends BaseStepDef {
  kind: 'open-pr';
  buildPr: (ctx: WorkflowStepContext<W>) => { title: string; body: string };
  /** PR comment posted on the freshly-opened PR (the root-cause / approach / review summary). */
  prCommentSection?: (ctx: WorkflowStepContext<W>) => CommentSection;
  onOpened: (info: { url: string; number: number; headSha: string }, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
}

/** Push new commits to the existing PR branch (ci-followup), then post a PR comment. */
export interface PushStepDef<W> extends BaseStepDef {
  kind: 'push';
  /** PR comment posted after the push. */
  prCommentSection?: (ctx: WorkflowStepContext<W>) => CommentSection;
  onPushed: (info: { headSha: string }, ctx: WorkflowStepContext<W>) => StepOutcome<W>;
}

export type WorkflowStep<W> =
  | AgentStepDef<W, unknown>
  | EffectStepDef<W>
  | HumanGateStepDef<W>
  | CommitStepDef<W>
  | OpenPrStepDef<W>
  | PushStepDef<W>;

// Helper so callers can author an AgentStepDef<W, T> with a concrete T and have
// it widen safely into WorkflowStep<W>. (TS can't infer T through the union.)
export function agentStep<W, T>(def: AgentStepDef<W, T>): WorkflowStep<W> {
  return def as unknown as WorkflowStep<W>;
}

/** Side-effect deps the engine threads into `effect`/`commit`/`open-pr`/`push` steps. */
export interface WorkflowEffectDeps {
  /** add label, set labels, close issue, post a one-off comment, etc. */
  github: {
    addComment(issueNumber: number, body: string): Promise<number | void>;
    updateComment(commentId: number, body: string): Promise<void>;
    setLabels(issueNumber: number, labels: string[]): Promise<void>;
    addLabel(issueNumber: number, label: string): Promise<void>;
    closeIssue(issueNumber: number, reason?: 'completed' | 'not_planned'): Promise<void>;
    pushBranch(branch: string, localRepoPath: string, remote?: string): Promise<void>;
    createPullRequest(opts: { title: string; body: string; head: string; base: string; draft?: boolean; labels?: string[] }): Promise<{ url: string; number: number }>;
  };
  /** git helpers in the worktree (commitAll / getDiffAgainstBase). */
  git: {
    commitAll(worktreePath: string, message: string): Promise<string | null>;
    getDiffAgainstBase(worktreePath: string, baseRef: string): Promise<string>;
  };
}

// ─── Workflow ───────────────────────────────────────────────────────────────

export interface WorkflowLoop<W> {
  id: string;
  /** Ids of the steps that form the loop body, in order. */
  stepIds: string[];
  /** When this returns true *after* a loop iteration, stop iterating. */
  until: (ctx: WorkflowStepContext<W>) => boolean;
  maxIterations: number;
}

export interface Workflow<W> {
  id: 'triage' | 'autofix' | 'ci-followup';
  title: string;
  /** Pre-PR steps edit the issue comment; once a PR exists, post-PR steps edit a PR comment (docs §3.6). */
  commentTargetOrder: CommentTarget[];
  initialBlackboard: () => W;
  steps: WorkflowStep<W>[];
  loops?: WorkflowLoop<W>[];
}

// ─── In-memory run records (become the `agent_runs` rows in Phase 3) ─────────

/** One step execution. Phase 2 keeps these in memory; Phase 3 persists them to Supabase. */
export interface AgentRunRecord {
  id: string;
  workflow: string;
  stepId: string;
  /** The step's kind (`agent`/`effect`/…) — handy for the cockpit's per-row icon. */
  kind?: WorkflowStepKind;
  /** Loop iteration (0 = first pass / non-loop step). */
  iteration: number;
  backend: AgentBackend;
  model: string;
  status: StepRunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Cost-weighted tokens; 0 for non-agent steps or backends with no telemetry. */
  tokensUsed: number;
  summary?: string;
  error?: string;
}

export interface WorkflowRunResult<W> {
  status: WorkflowRunStatus;
  blackboard: W;
  runRecords: AgentRunRecord[];
  /** Set when `status` is `succeeded`-but-skipped, `failed`, `paused`, or `cancelled`. */
  reason?: string;
  /** For autofix runs that opened a PR. */
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  headSha?: string;
  /** Total cost-weighted tokens across all agent steps. */
  tokensUsed: number;
}
