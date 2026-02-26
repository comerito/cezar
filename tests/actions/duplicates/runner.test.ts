import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DuplicatesRunner, DuplicateResults } from '../../../src/actions/duplicates/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService, DuplicateMatch } from '../../../src/services/llm.service.js';

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '' },
    sync: { digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false },
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

function createMockLLM(results: DuplicateMatch[] = []): LLMService {
  return {
    detectDuplicates: vi.fn().mockResolvedValue(results),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('DuplicatesRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'runner-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(issueCount: number, digestAll = true, analyzeAll = false): Promise<IssueStore> {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    for (let i = 1; i <= issueCount; i++) {
      store.upsertIssue(makeIssueData(i));
      if (digestAll) {
        store.setDigest(i, { ...digest, summary: `Summary ${i}` });
      }
      if (analyzeAll) {
        store.setAnalysis(i, { duplicatesAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }
    await store.save();
    return store;
  }

  it('detects duplicates and persists to store', async () => {
    const store = await setupStore(5);
    const mockLLM = createMockLLM([
      { number: 3, duplicateOf: 1, confidence: 0.95, reason: 'Same bug' },
    ]);

    const runner = new DuplicatesRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.groups).toHaveLength(1);
    expect(results.groups[0].duplicate.number).toBe(3);
    expect(results.groups[0].original.number).toBe(1);
    expect(results.groups[0].confidence).toBe(0.95);

    // Check store was updated
    const issue3 = store.getIssue(3)!;
    expect(issue3.analysis.duplicateOf).toBe(1);
    expect(issue3.analysis.duplicateConfidence).toBe(0.95);
    expect(issue3.analysis.duplicatesAnalyzedAt).toBeTruthy();
  });

  it('marks non-duplicate candidates as analyzed', async () => {
    const store = await setupStore(3);
    const mockLLM = createMockLLM([]); // No duplicates found

    const runner = new DuplicatesRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);

    // All issues should be marked as analyzed even though none are duplicates
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.duplicatesAnalyzedAt).toBeTruthy();
    }
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore(5, true, true); // All analyzed
    const mockLLM = createMockLLM([]);

    const runner = new DuplicatesRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.detect();
    expect(results.message).toContain('already analyzed');
    expect(mockLLM.detectDuplicates).not.toHaveBeenCalled();

    // With recheck — should run
    const results2 = await runner.detect({ recheck: true });
    expect(mockLLM.detectDuplicates).toHaveBeenCalled();
  });

  it('skips issues without digest', async () => {
    const store = await setupStore(3, false); // No digests
    const mockLLM = createMockLLM([]);

    const runner = new DuplicatesRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.message).toContain('already analyzed');
    expect(mockLLM.detectDuplicates).not.toHaveBeenCalled();
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.duplicateBatchSize = 2;

    const store = await setupStore(5);
    const mockLLM = createMockLLM([]);

    const runner = new DuplicatesRunner(store, config, mockLLM);
    await runner.detect();

    // 5 issues / batch size 2 = 3 batches
    expect(mockLLM.detectDuplicates).toHaveBeenCalledTimes(3);
  });

  it('empty result has correct properties', () => {
    const results = DuplicateResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });
});
