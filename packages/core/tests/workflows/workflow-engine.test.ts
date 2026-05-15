import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runWorkflow, type WorkflowGitHub } from '../../src/workflows/workflow-engine.js';
import { agentStep, type Workflow, type AgentRunRecord } from '../../src/workflows/workflow.js';
import type { AgentBackend, AgentRunner, AgentRunResult, AgentRunSpec } from '../../src/agents/agent-runner.js';
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';
import type { WorkflowBinding } from '../../src/workflows/binding.js';

// ─── fakes ──────────────────────────────────────────────────────────────────

function makeConfig() {
  return ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
  });
}

async function makeStore(): Promise<IssueStore> {
  const data: Store = {
    meta: { owner: 'acme', repo: 'cezar', lastSyncedAt: null, totalFetched: 0, version: 1, orgMembers: [], orgMembersFetchedAt: null },
    issues: [],
  };
  return IssueStore.fromPort({ load: async () => data, save: async () => {} });
}

interface FakeGitHub extends WorkflowGitHub {
  added: Array<{ n: number; body: string }>;
  updated: Array<{ id: number; body: string }>;
}

function makeFakeGitHub(): FakeGitHub {
  const added: Array<{ n: number; body: string }> = [];
  const updated: Array<{ id: number; body: string }> = [];
  let nextId = 1000;
  return {
    added,
    updated,
    async addComment(n, body) { added.push({ n, body }); return nextId++; },
    async updateComment(id, body) { updated.push({ id, body }); },
    async getIssueWithComments(n) {
      return { issue: { number: n, title: `Issue #${n}`, body: 'a synthetic issue body', }, comments: [] };
    },
    async setLabels() {},
    async addLabel() {},
    async closeIssue() {},
    async pushBranch() {},
    async createPullRequest() { return { url: 'https://example.test/pr/7', number: 7 }; },
  };
}

/**
 * A stub `AgentRunner` whose `run()` returns canned parsed outputs in sequence
 * (one per call). Records the specs it received so tests can inspect the
 * resolved prompt/model/tools. Advertises a configurable `backend`.
 */
class FakeRunner implements AgentRunner {
  readonly specs: AgentRunSpec<unknown>[] = [];
  private idx = 0;
  constructor(
    readonly backend: AgentBackend,
    private readonly outputs: unknown[],
    private readonly opts: { tokensPerCall?: number; rawText?: string } = {},
  ) {}
  async run<T>(spec: AgentRunSpec<T>): Promise<AgentRunResult<T>> {
    this.specs.push(spec as AgentRunSpec<unknown>);
    const parsed = (this.outputs[this.idx] ?? null) as T | null;
    this.idx++;
    return {
      text: this.opts.rawText ?? JSON.stringify(parsed),
      parsed,
      toolCalls: [],
      tokensUsed: this.opts.tokensPerCall ?? 42,
      budgetExceeded: false,
    };
  }
  async interrupt(): Promise<void> {}
}

// ─── a tiny synthetic workflow: 2 agent steps + a loop on the 2nd ───────────

const StepASchema = z.object({ ok: z.boolean(), note: z.string() });
const StepBSchema = z.object({ pass: z.boolean(), note: z.string() });

interface TinyBB { a?: z.infer<typeof StepASchema>; b?: z.infer<typeof StepBSchema>; retryNotes?: string }

function tinyWorkflow(): Workflow<TinyBB> {
  return {
    id: 'autofix', // reuse an allowed id
    title: 'Tiny',
    commentTargetOrder: ['issue'],
    initialBlackboard: () => ({}),
    steps: [
      agentStep<TinyBB, z.infer<typeof StepASchema>>({
        id: 'step-a',
        kind: 'agent',
        builtinSkillId: 'step-a',
        builtinSystemPrompt: 'SYSTEM-A',
        builtinModel: 'model-a',
        builtinTools: ['Read'],
        responseSchema: StepASchema,
        cwdRequired: false,
        buildUserPrompt: () => 'USER-A',
        onResult: (parsed) => parsed.ok ? { kind: 'continue', blackboardPatch: { a: parsed } } : { kind: 'fail', reason: 'step-a not ok' },
        commentSection: (parsed) => ({ heading: 'Step A', body: parsed.note }),
      }),
      agentStep<TinyBB, z.infer<typeof StepBSchema>>({
        id: 'step-b',
        kind: 'agent',
        builtinSkillId: 'step-b',
        builtinSystemPrompt: 'SYSTEM-B',
        builtinModel: 'model-b',
        builtinTools: ['Read', 'Grep'],
        responseSchema: StepBSchema,
        cwdRequired: false,
        buildUserPrompt: () => 'USER-B',
        onResult: (parsed) => parsed.pass
          ? { kind: 'continue', blackboardPatch: { b: parsed } }
          : { kind: 'fail', reason: 'review failed', retriable: true, blackboardPatch: { retryNotes: parsed.note, b: parsed } },
        commentSection: (parsed) => ({ heading: 'Step B', body: parsed.note }),
      }),
    ],
    loops: [{ id: 'b-loop', stepIds: ['step-b'], until: (ctx) => ctx.blackboard.b?.pass === true, maxIterations: 3 }],
  };
}

function baseCtx() {
  return {
    config: makeConfig(),
    issueNumber: 5,
    apply: false,
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('WorkflowEngine.runWorkflow', () => {
  it('runs steps in order, posts the living comment once, edits it per step', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new FakeRunner('anthropic-api', [
      { ok: true, note: 'a-done' },
      { pass: true, note: 'b-done' },
    ]);
    const records: AgentRunRecord[] = [];
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github,
      runnerFactory: () => runner,
      onRunRecord: (r) => records.push(r),
    });

    expect(result.status).toBe('succeeded');
    expect(result.blackboard.a?.note).toBe('a-done');
    expect(result.blackboard.b?.note).toBe('b-done');
    // step order
    expect(runner.specs.map((s) => s.systemPrompt)).toEqual(['SYSTEM-A', 'SYSTEM-B']);
    expect(runner.specs.map((s) => s.userPrompt)).toEqual(['USER-A', 'USER-B']);
    // living comment: one addComment (the in-progress shell) on the issue,
    // then updateComment per step (start shell already exists, +2 sections).
    expect(github.added).toHaveLength(1);
    expect(github.added[0].n).toBe(5);
    expect(github.updated.length).toBeGreaterThanOrEqual(2);
    const lastBody = github.updated[github.updated.length - 1].body;
    expect(lastBody).toContain('Step A');
    expect(lastBody).toContain('a-done');
    expect(lastBody).toContain('Step B');
    expect(lastBody).toContain('b-done');
    expect(lastBody).toContain('done'); // finalize header / footer
    // run records: one per agent step, with the right backend/model/status
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ stepId: 'step-a', backend: 'anthropic-api', model: 'model-a', status: 'succeeded', tokensUsed: 42 });
    expect(records[1]).toMatchObject({ stepId: 'step-b', backend: 'anthropic-api', model: 'model-b', status: 'succeeded', tokensUsed: 42 });
    expect(result.tokensUsed).toBe(84);
  });

  it('applies resolveStepConfig — a binding\'s skill body shows up in the spec', async () => {
    const store = await makeStore();
    const runner = new FakeRunner('anthropic-api', [{ ok: true, note: 'a' }, { pass: true, note: 'b' }]);
    const bindings: WorkflowBinding[] = [{
      stepId: 'step-a',
      skillName: 'repo-skill',
      backend: null,
      model: 'model-a-override',
      extraTools: ['WebFetch'],
    }];
    await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github: makeFakeGitHub(),
      runnerFactory: () => runner,
      bindings,
      skills: [{ name: 'repo-skill', body: 'CHECK-THE-MIDDLEWARE-FIRST', path: '/x/.ai/skills/repo-skill.md', suggestedStages: [] }],
    });
    const specA = runner.specs[0];
    expect(specA.systemPrompt).toContain('SYSTEM-A');
    expect(specA.systemPrompt).toContain('## Repo-specific guidance');
    expect(specA.systemPrompt).toContain('CHECK-THE-MIDDLEWARE-FIRST');
    expect(specA.model).toBe('model-a-override');
    expect(specA.allowedTools).toEqual(['Read', 'WebFetch']);
  });

  it('separateCommentPerStep posts N comments instead of editing one', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new FakeRunner('anthropic-api', [{ ok: true, note: 'a' }, { pass: true, note: 'b' }]);
    await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github,
      runnerFactory: () => runner,
      settings: { autoTriageEnabled: true, autofixEnabled: false, separateCommentPerStep: true },
    });
    // one comment per section, no edits
    expect(github.added.length).toBe(2);
    expect(github.updated.length).toBe(0);
    expect(github.added[0].body).toContain('Step A');
    expect(github.added[1].body).toContain('Step B');
  });

  it('a retriable fail from the loop\'s last step re-runs the loop up to maxIterations then ends failed', async () => {
    const store = await makeStore();
    const runner = new FakeRunner('anthropic-api', [
      { ok: true, note: 'a' },
      { pass: false, note: 'try harder 1' },
      { pass: false, note: 'try harder 2' },
      { pass: false, note: 'try harder 3' },
      { pass: false, note: 'try harder 4' }, // never reached — maxIterations 3
    ]);
    const records: AgentRunRecord[] = [];
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github: makeFakeGitHub(),
      runnerFactory: () => runner,
      onRunRecord: (r) => records.push(r),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/review failed/);
    expect(result.reason).toMatch(/exhausted 3 iteration/);
    // step-b ran 3 times (iterations 0,1,2); step-a once.
    const bRecords = records.filter((r) => r.stepId === 'step-b');
    expect(bRecords).toHaveLength(3);
    expect(bRecords.map((r) => r.iteration)).toEqual([0, 1, 2]);
    // retry notes carried into the blackboard
    expect(result.blackboard.retryNotes).toBe('try harder 3');
  });

  it('loop iterates once then passes — carries retry notes into the 2nd attempt', async () => {
    const store = await makeStore();
    const runner = new FakeRunner('anthropic-api', [
      { ok: true, note: 'a' },
      { pass: false, note: 'blocker: do X' },
      { pass: true, note: 'now good' },
    ]);
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github: makeFakeGitHub(),
      runnerFactory: () => runner,
    });
    expect(result.status).toBe('succeeded');
    expect(result.blackboard.b?.note).toBe('now good');
    // step-b ran twice
    expect(runner.specs.filter((s) => s.systemPrompt === 'SYSTEM-B')).toHaveLength(2);
  });

  it('a human-gate with no decision callback and no auto-proceed ⇒ run ends paused', async () => {
    const store = await makeStore();
    const wf: Workflow<TinyBB> = {
      id: 'autofix',
      title: 'Gated',
      commentTargetOrder: ['issue'],
      initialBlackboard: () => ({}),
      steps: [
        { id: 'gate', kind: 'human-gate', builtinSkillId: 'gate', buildPrompt: () => ({ stepId: 'gate', question: 'go?', options: ['proceed', 'skip'] }) },
        agentStep<TinyBB, z.infer<typeof StepASchema>>({
          id: 'step-a', kind: 'agent', builtinSkillId: 'step-a', builtinSystemPrompt: 'S', builtinModel: 'm', builtinTools: [],
          responseSchema: StepASchema, cwdRequired: false, buildUserPrompt: () => 'u',
          onResult: () => ({ kind: 'continue' }),
        }),
      ],
    };
    const runner = new FakeRunner('anthropic-api', [{ ok: true, note: 'a' }]);
    const result = await runWorkflow(wf, { ...baseCtx(), store, github: makeFakeGitHub(), runnerFactory: () => runner });
    expect(result.status).toBe('paused');
    expect(result.reason).toMatch(/awaiting human decision/);
    // the agent step never ran
    expect(runner.specs).toHaveLength(0);
  });

  it('a human-gate with a decision callback resolves and continues', async () => {
    const store = await makeStore();
    const wf: Workflow<TinyBB> = {
      id: 'autofix',
      title: 'Gated',
      commentTargetOrder: ['issue'],
      initialBlackboard: () => ({}),
      steps: [
        { id: 'gate', kind: 'human-gate', builtinSkillId: 'gate', buildPrompt: () => ({ stepId: 'gate', question: 'go?', options: ['proceed', 'skip'] }) },
        agentStep<TinyBB, z.infer<typeof StepASchema>>({
          id: 'step-a', kind: 'agent', builtinSkillId: 'step-a', builtinSystemPrompt: 'S', builtinModel: 'm', builtinTools: [],
          responseSchema: StepASchema, cwdRequired: false, buildUserPrompt: () => 'u',
          onResult: () => ({ kind: 'continue' }),
        }),
      ],
    };
    const runner = new FakeRunner('anthropic-api', [{ ok: true, note: 'a' }]);
    const result = await runWorkflow(wf, {
      ...baseCtx(), store, github: makeFakeGitHub(), runnerFactory: () => runner,
      requestHumanDecision: async () => ({ choice: 'proceed' }),
    });
    expect(result.status).toBe('succeeded');
    expect(runner.specs).toHaveLength(1);
  });

  it('routes a non-anthropic backend from a binding to a runner advertising that backend', async () => {
    const store = await makeStore();
    const claudeCliRunner = new FakeRunner('claude-cli', [{ ok: true, note: 'a' }]);
    const apiRunner = new FakeRunner('anthropic-api', [{ pass: true, note: 'b' }]);
    const seen: AgentBackend[] = [];
    const records: AgentRunRecord[] = [];
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(),
      store,
      github: makeFakeGitHub(),
      bindings: [{ stepId: 'step-a', skillName: null, backend: 'claude-cli', model: null, extraTools: [] }],
      runnerFactory: (backend) => {
        seen.push(backend);
        return backend === 'claude-cli' ? claudeCliRunner : apiRunner;
      },
      onRunRecord: (r) => records.push(r),
    });
    expect(result.status).toBe('succeeded');
    expect(seen).toEqual(['claude-cli', 'anthropic-api']);
    expect(records.find((r) => r.stepId === 'step-a')?.backend).toBe('claude-cli');
    expect(claudeCliRunner.specs).toHaveLength(1);
    expect(apiRunner.specs).toHaveLength(1);
  });

  it('honors loopMaxIterations override from the run context', async () => {
    const store = await makeStore();
    const runner = new FakeRunner('anthropic-api', [
      { ok: true, note: 'a' },
      { pass: false, note: 'x' },
      { pass: false, note: 'y' }, // only 1 retry allowed → never reached
    ]);
    const records: AgentRunRecord[] = [];
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(), store, github: makeFakeGitHub(), runnerFactory: () => runner,
      loopMaxIterations: { 'b-loop': 1 },
      onRunRecord: (r) => records.push(r),
    });
    expect(result.status).toBe('failed');
    expect(records.filter((r) => r.stepId === 'step-b')).toHaveLength(1);
  });

  it('pause requested between steps ⇒ run ends paused', async () => {
    const store = await makeStore();
    let calls = 0;
    const runner = new FakeRunner('anthropic-api', [{ ok: true, note: 'a' }, { pass: true, note: 'b' }]);
    const result = await runWorkflow(tinyWorkflow(), {
      ...baseCtx(), store, github: makeFakeGitHub(), runnerFactory: () => runner,
      pauseRequested: () => { calls++; return calls > 1; }, // allow step-a, pause before step-b
    });
    expect(result.status).toBe('paused');
    expect(runner.specs).toHaveLength(1);
  });
});
