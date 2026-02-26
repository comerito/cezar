import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MilestonePlanRunner, MilestonePlanResults } from '../../../src/actions/milestone-planner/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { MilestonePlanResponse } from '../../../src/actions/milestone-planner/prompt.js';

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '' },
    sync: {
      digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false,
      labelBatchSize: 20, missingInfoBatchSize: 15, recurringBatchSize: 15,
      priorityBatchSize: 20, securityBatchSize: 20, staleDaysThreshold: 90, staleCloseDays: 14,
    },
  };
}

function makeIssueData(number: number, overrides: Record<string, unknown> = {}) {
  const title = `Issue ${number}`;
  const body = `Body for issue ${number}`;
  return {
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    author: 'user1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: contentHash(title, body),
    commentCount: 0,
    reactions: 0,
    ...overrides,
  };
}

const digest = {
  summary: 'A test issue',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

const sampleResponse: MilestonePlanResponse = {
  milestones: [
    {
      name: 'v-next — Bug Fixes',
      theme: 'Critical bug fixes',
      issues: [1, 2],
      effort: 'small',
      rationale: 'Group critical bugs for quick release',
    },
    {
      name: 'v-next+1 — Features',
      theme: 'New functionality',
      issues: [3, 4],
      effort: 'medium',
      rationale: 'Feature development after stabilization',
    },
  ],
  unassigned: [5],
};

function createMockLLM(response: MilestonePlanResponse | null = sampleResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('MilestonePlanRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'milestone-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    openCount?: number;
    closedCount?: number;
    withPriority?: boolean;
  } = {}): Promise<IssueStore> {
    const { openCount = 0, closedCount = 0, withPriority = false } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < openCount; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...digest, summary: `Summary ${num}` });
      if (withPriority) {
        const priorities = ['critical', 'high', 'medium', 'low'] as const;
        store.setAnalysis(num, { priority: priorities[i % 4] });
      }
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
      store.setDigest(num, { ...digest, summary: `Closed ${num}` });
    }

    await store.save();
    return store;
  }

  it('generates milestone plan from open issues', async () => {
    const store = await setupStore({ openCount: 5 });
    const mockLLM = createMockLLM();

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    const results = await runner.plan();

    expect(results.milestones).toHaveLength(2);
    expect(results.milestones[0].name).toBe('v-next — Bug Fixes');
    expect(results.milestones[0].theme).toBe('Critical bug fixes');
    expect(results.milestones[0].effort).toBe('small');
    expect(results.milestones[0].rationale).toBe('Group critical bugs for quick release');
    expect(results.milestones[0].issues).toHaveLength(2);
    expect(results.milestones[0].issues[0].number).toBe(1);
    expect(results.milestones[0].issues[0].title).toBe('Issue 1');

    expect(results.unassigned).toHaveLength(1);
    expect(results.unassigned[0].number).toBe(5);
    expect(results.unassigned[0].title).toBe('Issue 5');
  });

  it('resolves issue titles from store', async () => {
    const store = await setupStore({ openCount: 5 });
    const mockLLM = createMockLLM();

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    const results = await runner.plan();

    // All issues should have resolved titles
    for (const ms of results.milestones) {
      for (const issue of ms.issues) {
        expect(issue.title).toBe(`Issue ${issue.number}`);
      }
    }
  });

  it('includes priority in resolved issues when available', async () => {
    const store = await setupStore({ openCount: 5, withPriority: true });
    const mockLLM = createMockLLM();

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    const results = await runner.plan();

    // Issue 1 has critical priority (index 0 % 4 = 0 → critical)
    expect(results.milestones[0].issues[0].priority).toBe('critical');
    // Issue 2 has high priority (index 1 % 4 = 1 → high)
    expect(results.milestones[0].issues[1].priority).toBe('high');
  });

  it('returns empty when fewer than 3 open issues', async () => {
    const store = await setupStore({ openCount: 2 });
    const mockLLM = createMockLLM();

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    const results = await runner.plan();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('at least 3');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('returns empty when LLM fails', async () => {
    const store = await setupStore({ openCount: 5 });
    const mockLLM = createMockLLM(null);

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    const results = await runner.plan();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('LLM failed');
  });

  it('empty result has correct properties', () => {
    const results = MilestonePlanResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
    expect(results.milestones).toHaveLength(0);
    expect(results.unassigned).toHaveLength(0);
  });

  it('only uses open issues, not closed', async () => {
    const store = await setupStore({ openCount: 4, closedCount: 3 });
    const mockLLM = createMockLLM({
      milestones: [{ name: 'M1', theme: 'T', issues: [1, 2, 3, 4], effort: 'small', rationale: 'R' }],
      unassigned: [],
    });

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    await runner.plan();

    // Only open issues (1-4) should be in the prompt, not closed (5-7)
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#4');
    expect(prompt).not.toContain('#5');
    expect(prompt).not.toContain('#7');
  });

  it('includes priority info in prompt', async () => {
    const store = await setupStore({ openCount: 3, withPriority: true });
    const mockLLM = createMockLLM({
      milestones: [{ name: 'M1', theme: 'T', issues: [1, 2, 3], effort: 'small', rationale: 'R' }],
      unassigned: [],
    });

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    await runner.plan();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('critical');
    expect(prompt).toContain('high');
    expect(prompt).toContain('medium');
  });

  it('does not persist anything to store', async () => {
    const store = await setupStore({ openCount: 5 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM();

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    await runner.plan();

    // plan() should never call save — it's ephemeral
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('makes a single LLM call (not batched)', async () => {
    const store = await setupStore({ openCount: 10 });
    const mockLLM = createMockLLM({
      milestones: [{ name: 'M1', theme: 'T', issues: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], effort: 'large', rationale: 'R' }],
      unassigned: [],
    });

    const runner = new MilestonePlanRunner(store, makeConfig(), mockLLM);
    await runner.plan();

    // Should be exactly 1 LLM call, not batched
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
  });
});
