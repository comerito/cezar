import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IssueCheckRunner, IssueCheckResults } from '../../../src/actions/issue-check/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { IssueCheckResponse } from '../../../src/actions/issue-check/prompt.js';

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '' },
    sync: {
      digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false,
      labelBatchSize: 20, missingInfoBatchSize: 15, recurringBatchSize: 15,
      priorityBatchSize: 20, securityBatchSize: 20, staleDaysThreshold: 90, staleCloseDays: 14,
      doneDetectorBatchSize: 10, needsResponseBatchSize: 15,
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
  };
}

const digest = {
  summary: 'A test issue',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

function createMockLLM(response: IssueCheckResponse | null): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('IssueCheckRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-check-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(issueCount: number, withDigest = true): Promise<IssueStore> {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    for (let i = 1; i <= issueCount; i++) {
      store.upsertIssue(makeIssueData(i));
      if (withDigest) {
        store.setDigest(i, { ...digest, summary: `Summary ${i}` });
      }
    }
    await store.save();
    return store;
  }

  it('returns matches sorted by confidence', async () => {
    const store = await setupStore(5);
    const mockLLM = createMockLLM({
      matches: [
        { number: 2, confidence: 0.70, reason: 'Partial match' },
        { number: 4, confidence: 0.95, reason: 'Very similar' },
        { number: 1, confidence: 0.80, reason: 'Related issue' },
      ],
    });

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    const results = await runner.check({ description: 'app crashes on submit' });

    expect(results.matches).toHaveLength(3);
    expect(results.matches[0].confidence).toBe(0.95);
    expect(results.matches[0].issue.number).toBe(4);
    expect(results.matches[1].confidence).toBe(0.80);
    expect(results.matches[2].confidence).toBe(0.70);
  });

  it('returns empty when LLM finds no matches', async () => {
    const store = await setupStore(3);
    const mockLLM = createMockLLM({ matches: [] });

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    const results = await runner.check({ description: 'totally new issue' });

    expect(results.isEmpty).toBe(true);
    expect(results.matches).toHaveLength(0);
  });

  it('passes description and open issues to LLM prompt', async () => {
    const store = await setupStore(3);
    const mockLLM = createMockLLM({ matches: [] });

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    await runner.check({ description: 'my specific bug description' });

    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const [prompt] = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(prompt).toContain('my specific bug description');
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).toContain('#3');
  });

  it('handles LLM returning null (parse failure)', async () => {
    const store = await setupStore(3);
    const mockLLM = createMockLLM(null);

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    const results = await runner.check({ description: 'some description' });

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('could not be parsed');
  });

  it('returns early when no open issues with digest exist', async () => {
    const store = await setupStore(0);
    const mockLLM = createMockLLM({ matches: [] });

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    const results = await runner.check({ description: 'some issue' });

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No open issues');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('skips matches for issue numbers not in store', async () => {
    const store = await setupStore(3);
    const mockLLM = createMockLLM({
      matches: [
        { number: 1, confidence: 0.90, reason: 'Match' },
        { number: 999, confidence: 0.85, reason: 'Ghost issue' },
      ],
    });

    const runner = new IssueCheckRunner(store, makeConfig(), mockLLM);
    const results = await runner.check({ description: 'test' });

    expect(results.matches).toHaveLength(1);
    expect(results.matches[0].issue.number).toBe(1);
  });

  it('empty result has correct properties', () => {
    const results = IssueCheckResults.empty('test desc', 'No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
    expect(results.description).toBe('test desc');
  });
});
