import { describe, expect, it } from 'vitest';
import { runWorkflow, type WorkflowGitHub } from '../../src/workflows/workflow-engine.js';
import { triageWorkflow, triageOutcomeFromBlackboard } from '../../src/workflows/definitions/triage.workflow.js';
import type { AgentBackend, AgentRunner, AgentRunResult, AgentRunSpec } from '../../src/agents/agent-runner.js';
import { IssueStore } from '../../src/store/store.js';
import { ConfigSchema } from '../../src/config/config.model.js';
import type { Store } from '../../src/store/store.model.js';

function makeConfig(autofixEnabled = false) {
  const cfg = ConfigSchema.parse({
    github: { owner: 'acme', repo: 'cezar', token: 'token' },
    llm: { apiKey: 'test-key' },
    store: { path: '.issue-store-test' },
  });
  cfg.autofix.enabled = autofixEnabled;
  return cfg;
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
  labelsAdded: Array<{ n: number; label: string }>;
}

function makeFakeGitHub(): FakeGitHub {
  const added: Array<{ n: number; body: string }> = [];
  const updated: Array<{ id: number; body: string }> = [];
  const labelsAdded: Array<{ n: number; label: string }> = [];
  let nextId = 1000;
  return {
    added,
    updated,
    labelsAdded,
    async addComment(n, body) { added.push({ n, body }); return nextId++; },
    async updateComment(id, body) { updated.push({ id, body }); },
    async getIssueWithComments(n) {
      return { issue: { number: n, title: `Crash on startup`, body: 'It crashes with a NPE every time.' }, comments: [] };
    },
    async setLabels() {},
    async addLabel(n, label) { labelsAdded.push({ n, label }); },
    async closeIssue() {},
    async pushBranch() {},
    async createPullRequest() { return { url: 'https://example.test/pr/1', number: 1 }; },
  };
}

class FakeRunner implements AgentRunner {
  readonly specs: AgentRunSpec<unknown>[] = [];
  private idx = 0;
  constructor(readonly backend: AgentBackend, private readonly outputs: unknown[]) {}
  async run<T>(spec: AgentRunSpec<T>): Promise<AgentRunResult<T>> {
    this.specs.push(spec as AgentRunSpec<unknown>);
    const parsed = (this.outputs[this.idx] ?? null) as T | null;
    this.idx++;
    return { text: JSON.stringify(parsed), parsed, toolCalls: [], tokensUsed: 10, budgetExceeded: false };
  }
  async interrupt(): Promise<void> {}
}

describe('triageWorkflow', () => {
  it('classifies → prioritizes → routes, applies labels, posts a summary comment', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new FakeRunner('anthropic-api', [
      { classifications: [{ number: 42, issueType: 'bug', confidence: 0.91, reason: 'has a stack trace' }] },
      { priorities: [{ number: 42, priority: 'high', reason: 'breaks startup', signals: ['startup'] }] },
      { route: 'autofix', reason: 'well-specified reproducible bug' },
    ]);

    const result = await runWorkflow(triageWorkflow, {
      store,
      config: makeConfig(true), // autofix enabled → summary should say "queue an automated fix"
      github,
      issueNumber: 42,
      apply: true,
      runnerFactory: () => runner,
    });

    expect(result.status).toBe('succeeded');
    expect(result.blackboard.isBug).toMatchObject({ issueType: 'bug', confidence: 0.91 });
    expect(result.blackboard.priority).toMatchObject({ priority: 'high' });
    expect(result.blackboard.route).toMatchObject({ route: 'autofix' });

    const outcome = triageOutcomeFromBlackboard(result.blackboard);
    expect(outcome).toMatchObject({ route: 'autofix', issueType: 'bug', bugConfidence: 0.91, priority: 'high' });

    // labels derived: type ('bug') + priority:high
    expect(github.labelsAdded.map((l) => l.label).sort()).toEqual(['bug', 'priority:high']);

    // a living comment was posted on the issue and ends with the route + next-step
    expect(github.added).toHaveLength(1);
    expect(github.added[0].n).toBe(42);
    const lastBody = github.updated[github.updated.length - 1].body;
    expect(lastBody).toContain('autofix');
    expect(lastBody).toContain('queue an automated fix');
  });

  it('label-only route → no type label is applied beyond the derived ones, summary says "labelled"', async () => {
    const store = await makeStore();
    const github = makeFakeGitHub();
    const runner = new FakeRunner('anthropic-api', [
      { classifications: [{ number: 7, issueType: 'feature', confidence: 0.8, reason: 'asks for new API' }] },
      { priorities: [{ number: 7, priority: 'low', reason: 'nice to have', signals: ['enhancement'] }] },
      { route: 'label-only', reason: 'feature request' },
    ]);
    const result = await runWorkflow(triageWorkflow, {
      store,
      config: makeConfig(false),
      github,
      issueNumber: 7,
      apply: true,
      runnerFactory: () => runner,
    });
    expect(result.status).toBe('succeeded');
    expect(result.blackboard.route?.route).toBe('label-only');
    expect(github.labelsAdded.map((l) => l.label).sort()).toEqual(['enhancement', 'priority:low']);
    const lastBody = github.updated[github.updated.length - 1].body;
    expect(lastBody.toLowerCase()).toContain('labelled');
  });
});
