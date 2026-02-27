import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StaleRunner, StaleResults } from '../../../src/actions/stale/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { StaleAnalysisResponse } from '../../../src/actions/stale/prompt.js';

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

// Helper to create a date N days ago in ISO format
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
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
    updatedAt: daysAgo(120), // 120 days ago by default — stale
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

function createMockLLM(response: StaleAnalysisResponse | null): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('StaleRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stale-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    staleCount?: number;
    freshCount?: number;
    closedCount?: number;
    analyzedCount?: number;
  } = {}): Promise<IssueStore> {
    const { staleCount = 0, freshCount = 0, closedCount = 0, analyzedCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < staleCount; i++, num++) {
      store.upsertIssue(makeIssueData(num)); // defaults to 120 days ago
      store.setDigest(num, { ...digest, summary: `Stale issue ${num}` });
      if (i < analyzedCount) {
        store.setAnalysis(num, { staleAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < freshCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { updatedAt: daysAgo(10) })); // recent
      store.setDigest(num, { ...digest, summary: `Fresh issue ${num}` });
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
      store.setDigest(num, { ...digest, summary: `Closed issue ${num}` });
    }

    await store.save();
    return store;
  }

  it('analyzes stale issues and persists to store', async () => {
    const store = await setupStore({ staleCount: 3 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, action: 'close-resolved', reason: 'Fixed in #50', draftComment: 'This was fixed in #50.' },
        { number: 2, action: 'label-stale', reason: 'Unclear if still relevant', draftComment: 'Is this still an issue?' },
        { number: 3, action: 'keep-open', reason: 'Still valid and unresolved', draftComment: '' },
      ],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.items).toHaveLength(3);
    // Sorted by action: close-resolved first, then label-stale, then keep-open
    expect(results.items[0].action).toBe('close-resolved');
    expect(results.items[0].number).toBe(1);
    expect(results.items[1].action).toBe('label-stale');
    expect(results.items[1].number).toBe(2);
    expect(results.items[2].action).toBe('keep-open');
    expect(results.items[2].number).toBe(3);

    // Check store persistence
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.staleAction).toBe('close-resolved');
    expect(issue1.analysis.staleReason).toBe('Fixed in #50');
    expect(issue1.analysis.staleDraftComment).toBe('This was fixed in #50.');
    expect(issue1.analysis.staleAnalyzedAt).toBeTruthy();
  });

  it('only targets issues past the staleness threshold', async () => {
    const store = await setupStore({ staleCount: 2, freshCount: 2 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, action: 'label-stale', reason: 'Stale', draftComment: 'Still relevant?' },
        { number: 2, action: 'label-stale', reason: 'Stale', draftComment: 'Still relevant?' },
      ],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // Only stale issues (1,2) should be in prompt, not fresh (3,4)
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).not.toContain('#3');
    expect(prompt).not.toContain('#4');
  });

  it('respects custom daysThreshold option', async () => {
    const store = await setupStore({ staleCount: 0, freshCount: 0 });
    // Add one issue that's 50 days old
    store.upsertIssue(makeIssueData(1, { updatedAt: daysAgo(50) }));
    store.setDigest(1, digest);
    await store.save();

    const mockLLM = createMockLLM({
      results: [{ number: 1, action: 'label-stale', reason: 'Stale', draftComment: 'Still relevant?' }],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);

    // Default 90-day threshold — should not find it
    const results90 = await runner.analyze({ daysThreshold: 90 });
    expect(results90.isEmpty).toBe(true);

    // Custom 30-day threshold — should find it
    const results30 = await runner.analyze({ daysThreshold: 30 });
    expect(results30.items).toHaveLength(1);
  });

  it('returns empty when no issues are stale', async () => {
    const store = await setupStore({ freshCount: 3 });
    const mockLLM = createMockLLM(null);

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No issues inactive');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ staleCount: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.analyze();
    expect(results.message).toContain('already analyzed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.analyze({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as keep-open', async () => {
    const store = await setupStore({ staleCount: 3 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, action: 'close-resolved', reason: 'Fixed', draftComment: 'Done' },
      ],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // Issues 2 and 3 weren't returned by LLM — should be marked keep-open
    expect(store.getIssue(2)!.analysis.staleAction).toBe('keep-open');
    expect(store.getIssue(2)!.analysis.staleAnalyzedAt).toBeTruthy();
    expect(store.getIssue(3)!.analysis.staleAction).toBe('keep-open');
  });

  it('includes closed issues as context in prompt', async () => {
    const store = await setupStore({ staleCount: 2, closedCount: 2 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Closed issues should appear in the "recently closed" context section
    expect(prompt).toContain('RECENTLY CLOSED');
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ staleCount: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      results: [
        { number: 1, action: 'label-stale', reason: 'Stale', draftComment: 'Stale?' },
      ],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    await runner.analyze({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = StaleResults.empty('No stale issues');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No stale issues');
    expect(results.items).toHaveLength(0);
  });

  it('computes daysSinceUpdate correctly', async () => {
    const store = await setupStore({ staleCount: 0 });
    store.upsertIssue(makeIssueData(1, { updatedAt: daysAgo(100) }));
    store.setDigest(1, digest);
    await store.save();

    const mockLLM = createMockLLM({
      results: [{ number: 1, action: 'label-stale', reason: 'Stale', draftComment: 'Stale?' }],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.items[0].daysSinceUpdate).toBeGreaterThanOrEqual(100);
    expect(results.items[0].daysSinceUpdate).toBeLessThanOrEqual(101);
  });

  it('actionCounts groups items correctly', async () => {
    const store = await setupStore({ staleCount: 4 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, action: 'close-resolved', reason: 'R', draftComment: 'C' },
        { number: 2, action: 'close-wontfix', reason: 'R', draftComment: 'C' },
        { number: 3, action: 'label-stale', reason: 'R', draftComment: 'C' },
        { number: 4, action: 'keep-open', reason: 'R', draftComment: '' },
      ],
    });

    const runner = new StaleRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.actionCounts).toEqual({
      'close-resolved': 1,
      'close-wontfix': 1,
      'label-stale': 1,
      'keep-open': 1,
    });
  });
});
