import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PriorityRunner, PriorityResults } from '../../../src/actions/priority/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { PriorityResponse } from '../../../src/actions/priority/prompt.js';

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '' },
    sync: {
      digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false,
      labelBatchSize: 20, missingInfoBatchSize: 15, recurringBatchSize: 15,
      priorityBatchSize: 20, securityBatchSize: 20, staleDaysThreshold: 90, staleCloseDays: 14, doneDetectorBatchSize: 10, needsResponseBatchSize: 15,
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

function createMockLLM(response: PriorityResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('PriorityRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'priority-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    count?: number;
    withDigest?: boolean;
    analyzedCount?: number;
  } = {}): Promise<IssueStore> {
    const { count = 0, withDigest = true, analyzedCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    for (let i = 1; i <= count; i++) {
      store.upsertIssue(makeIssueData(i));
      if (withDigest) {
        store.setDigest(i, { ...digest, summary: `Summary ${i}` });
      }
      if (i <= analyzedCount) {
        store.setAnalysis(i, { priorityAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    await store.save();
    return store;
  }

  it('assigns priorities and persists to store', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      priorities: [
        { number: 1, priority: 'critical', reason: 'Data loss', signals: ['data loss mentioned'] },
        { number: 2, priority: 'low', reason: 'Enhancement', signals: ['nice-to-have'] },
        { number: 3, priority: 'high', reason: 'Regression', signals: ['broken core feature'] },
      ],
    });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.items).toHaveLength(3);

    // Check store was updated
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.priority).toBe('critical');
    expect(issue1.analysis.priorityReason).toBe('Data loss');
    expect(issue1.analysis.prioritySignals).toEqual(['data loss mentioned']);
    expect(issue1.analysis.priorityAnalyzedAt).toBeTruthy();

    const issue2 = store.getIssue(2)!;
    expect(issue2.analysis.priority).toBe('low');
  });

  it('returns results sorted by priority (critical first)', async () => {
    const store = await setupStore({ count: 4 });
    const mockLLM = createMockLLM({
      priorities: [
        { number: 1, priority: 'low', reason: 'Low', signals: ['a'] },
        { number: 2, priority: 'critical', reason: 'Critical', signals: ['b'] },
        { number: 3, priority: 'medium', reason: 'Medium', signals: ['c'] },
        { number: 4, priority: 'high', reason: 'High', signals: ['d'] },
      ],
    });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.items.map(i => i.priority)).toEqual(['critical', 'high', 'medium', 'low']);
    expect(results.items.map(i => i.number)).toEqual([2, 4, 3, 1]);
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ count: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ priorities: [] });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.analyze();
    expect(results.message).toContain('already scored');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.analyze({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ count: 3 });
    // LLM only returns result for issue 1
    const mockLLM = createMockLLM({
      priorities: [
        { number: 1, priority: 'medium', reason: 'Test', signals: ['signal'] },
      ],
    });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // All 3 should be marked as analyzed
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.priorityAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.priorityBatchSize = 2;

    const store = await setupStore({ count: 5 });
    const mockLLM = createMockLLM({ priorities: [] });

    const runner = new PriorityRunner(store, config, mockLLM);
    await runner.analyze();

    // 5 issues / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ count: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      priorities: [
        { number: 1, priority: 'high', reason: 'Test', signals: ['signal'] },
      ],
    });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    await runner.analyze({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = PriorityResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('skips issues without digest', async () => {
    const store = await setupStore({ count: 3, withDigest: false });
    const mockLLM = createMockLLM({ priorities: [] });

    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.message).toContain('already scored');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('includes comment count and reactions in prompt', async () => {
    const store = await setupStore({ count: 0 });
    store.upsertIssue(makeIssueData(1, { commentCount: 15, reactions: 8 }));
    store.setDigest(1, { ...digest, summary: 'Popular bug' });
    await store.save();

    const mockLLM = createMockLLM({ priorities: [] });
    const runner = new PriorityRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Comments: 15');
    expect(prompt).toContain('Reactions: 8');
  });
});
