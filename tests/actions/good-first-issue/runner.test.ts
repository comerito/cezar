import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GoodFirstIssueRunner, GoodFirstIssueResults } from '../../../src/actions/good-first-issue/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { GoodFirstIssueResponse } from '../../../src/actions/good-first-issue/prompt.js';

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
    labels: [] as string[],
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

function createMockLLM(response: GoodFirstIssueResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('GoodFirstIssueRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gfi-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    count?: number;
    withDigest?: boolean;
    analyzedCount?: number;
    alreadyLabeled?: number[];
  } = {}): Promise<IssueStore> {
    const { count = 0, withDigest = true, analyzedCount = 0, alreadyLabeled = [] } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    for (let i = 1; i <= count; i++) {
      const labels = alreadyLabeled.includes(i) ? ['good first issue'] : [];
      store.upsertIssue(makeIssueData(i, { labels }));
      if (withDigest) {
        store.setDigest(i, { ...digest, summary: `Summary ${i}` });
      }
      if (i <= analyzedCount) {
        store.setAnalysis(i, { goodFirstIssueAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    await store.save();
    return store;
  }

  it('detects good first issues and persists to store', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, isGoodFirstIssue: true, reason: 'Self-contained', codeHint: 'Look at src/forms/', estimatedComplexity: 'small' },
        { number: 2, isGoodFirstIssue: false, reason: '', codeHint: '', estimatedComplexity: 'medium' },
        { number: 3, isGoodFirstIssue: true, reason: 'Clear scope', codeHint: 'Check src/utils/', estimatedComplexity: 'trivial' },
      ],
    });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.suggestions).toHaveLength(2);
    expect(results.suggestions[0].number).toBe(1);
    expect(results.suggestions[0].reason).toBe('Self-contained');
    expect(results.suggestions[0].codeHint).toBe('Look at src/forms/');
    expect(results.suggestions[0].estimatedComplexity).toBe('small');
    expect(results.suggestions[1].number).toBe(3);

    // Check store was updated for good first issue
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.isGoodFirstIssue).toBe(true);
    expect(issue1.analysis.goodFirstIssueReason).toBe('Self-contained');
    expect(issue1.analysis.goodFirstIssueHint).toBe('Look at src/forms/');
    expect(issue1.analysis.goodFirstIssueAnalyzedAt).toBeTruthy();

    // Non-good-first-issue should still be marked analyzed
    const issue2 = store.getIssue(2)!;
    expect(issue2.analysis.isGoodFirstIssue).toBe(false);
    expect(issue2.analysis.goodFirstIssueAnalyzedAt).toBeTruthy();
  });

  it('excludes issues already labeled good first issue', async () => {
    const store = await setupStore({ count: 3, alreadyLabeled: [2] });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // LLM should only receive issues 1 and 3, not issue 2
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).not.toContain('#2');
    expect(prompt).toContain('#3');
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ count: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.analyze();
    expect(results.message).toContain('already analyzed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.analyze({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ count: 3 });
    // LLM only returns result for issue 1
    const mockLLM = createMockLLM({
      results: [
        { number: 1, isGoodFirstIssue: false, reason: '', codeHint: '', estimatedComplexity: 'medium' },
      ],
    });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // All 3 should be marked as analyzed
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.goodFirstIssueAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.priorityBatchSize = 2;

    const store = await setupStore({ count: 5 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new GoodFirstIssueRunner(store, config, mockLLM);
    await runner.analyze();

    // 5 issues / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ count: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      results: [
        { number: 1, isGoodFirstIssue: true, reason: 'Easy', codeHint: 'src/', estimatedComplexity: 'trivial' },
      ],
    });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    await runner.analyze({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = GoodFirstIssueResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('skips issues without digest', async () => {
    const store = await setupStore({ count: 3, withDigest: false });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.message).toContain('already analyzed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('returns empty when all issues already have the label', async () => {
    const store = await setupStore({ count: 3, alreadyLabeled: [1, 2, 3] });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new GoodFirstIssueRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.message).toContain('already analyzed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });
});
