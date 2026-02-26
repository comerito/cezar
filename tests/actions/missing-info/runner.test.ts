import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MissingInfoRunner, MissingInfoResults } from '../../../src/actions/missing-info/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { MissingInfoResponse } from '../../../src/actions/missing-info/prompt.js';

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

const bugDigest = {
  summary: 'A test bug',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

const featureDigest = {
  summary: 'A test feature',
  category: 'feature' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

function createMockLLM(response: MissingInfoResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('MissingInfoRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'missing-info-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    bugs?: number;
    features?: number;
    analyzedBugs?: number;
  } = {}): Promise<IssueStore> {
    const { bugs = 0, features = 0, analyzedBugs = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < bugs; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...bugDigest, summary: `Bug ${num}` });
      if (i < analyzedBugs) {
        store.setAnalysis(num, { missingInfoAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < features; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...featureDigest, summary: `Feature ${num}` });
    }

    await store.save();
    return store;
  }

  it('detects issues with missing info and persists to store', async () => {
    const store = await setupStore({ bugs: 3 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, hasMissingInfo: true, missingFields: ['reproduction steps', 'OS'], suggestedComment: 'Please provide...' },
        { number: 2, hasMissingInfo: false, missingFields: [], suggestedComment: '' },
        { number: 3, hasMissingInfo: true, missingFields: ['error logs'], suggestedComment: 'Could you share...' },
      ],
    });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.items).toHaveLength(2);
    expect(results.items[0].number).toBe(1);
    expect(results.items[0].missingFields).toEqual(['reproduction steps', 'OS']);
    expect(results.items[1].number).toBe(3);

    // Check store was updated
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.missingInfoFields).toEqual(['reproduction steps', 'OS']);
    expect(issue1.analysis.missingInfoComment).toBe('Please provide...');
    expect(issue1.analysis.missingInfoAnalyzedAt).toBeTruthy();

    // Issue 2 has no missing info but should still be marked analyzed
    const issue2 = store.getIssue(2)!;
    expect(issue2.analysis.missingInfoFields).toBeNull();
    expect(issue2.analysis.missingInfoAnalyzedAt).toBeTruthy();
  });

  it('only analyzes bug-category issues', async () => {
    const store = await setupStore({ bugs: 2, features: 3 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);
    await runner.detect();

    // LLM should only receive the 2 bugs, not the 3 features
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).not.toContain('#3');
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ bugs: 3, analyzedBugs: 3 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.detect();
    expect(results.message).toContain('already checked');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.detect({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ bugs: 3 });
    // LLM only returns result for issue 1
    const mockLLM = createMockLLM({
      results: [
        { number: 1, hasMissingInfo: false, missingFields: [], suggestedComment: '' },
      ],
    });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);
    await runner.detect();

    // All 3 should be marked as analyzed
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.missingInfoAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.missingInfoBatchSize = 2;

    const store = await setupStore({ bugs: 5 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new MissingInfoRunner(store, config, mockLLM);
    await runner.detect();

    // 5 bugs / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ bugs: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      results: [
        { number: 1, hasMissingInfo: true, missingFields: ['steps'], suggestedComment: 'Please...' },
      ],
    });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);
    await runner.detect({ dryRun: true });

    // save() should not have been called during detect (only during setupStore)
    // Reset the spy call count after setup
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = MissingInfoResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('returns empty when no bugs exist', async () => {
    const store = await setupStore({ features: 5 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new MissingInfoRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.message).toContain('already checked');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });
});
