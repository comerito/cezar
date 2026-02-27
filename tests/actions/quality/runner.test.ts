import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QualityRunner, QualityResults } from '../../../src/actions/quality/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { QualityCheckResponse } from '../../../src/actions/quality/prompt.js';

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

function createMockLLM(response: QualityCheckResponse | null): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('QualityRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'quality-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    openCount?: number;
    closedCount?: number;
    analyzedCount?: number;
  } = {}): Promise<IssueStore> {
    const { openCount = 0, closedCount = 0, analyzedCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < openCount; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      if (i < analyzedCount) {
        store.setAnalysis(num, { qualityAnalyzedAt: '2024-01-01T00:00:00Z', qualityFlag: 'ok' });
      }
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
    }

    await store.save();
    return store;
  }

  it('flags low-quality issues and persists to store', async () => {
    const store = await setupStore({ openCount: 4 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'spam', reason: 'Promotional content', suggestedLabel: 'invalid' },
        { number: 2, quality: 'vague', reason: 'No actionable info', suggestedLabel: 'needs-info' },
        { number: 3, quality: 'ok', reason: '', suggestedLabel: null },
        { number: 4, quality: 'test', reason: 'Test submission', suggestedLabel: 'invalid' },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    const results = await runner.check();

    // Only non-ok issues should be in flagged results
    expect(results.flagged).toHaveLength(3);
    expect(results.flagged[0].flag).toBe('spam');
    expect(results.flagged[0].suggestedLabel).toBe('invalid');
    expect(results.flagged[1].flag).toBe('vague');
    expect(results.flagged[1].suggestedLabel).toBe('needs-info');
    expect(results.flagged[2].flag).toBe('test');

    // Check store persistence
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.qualityFlag).toBe('spam');
    expect(issue1.analysis.qualityReason).toBe('Promotional content');
    expect(issue1.analysis.qualityAnalyzedAt).toBeTruthy();

    // ok issue should also be persisted
    const issue3 = store.getIssue(3)!;
    expect(issue3.analysis.qualityFlag).toBe('ok');
    expect(issue3.analysis.qualityAnalyzedAt).toBeTruthy();
  });

  it('only checks open issues', async () => {
    const store = await setupStore({ openCount: 2, closedCount: 2 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'ok', reason: '', suggestedLabel: null },
        { number: 2, quality: 'ok', reason: '', suggestedLabel: null },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    await runner.check();

    // Only open issues (1,2) should be in prompt, not closed (3,4)
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).not.toContain('#3');
    expect(prompt).not.toContain('#4');
  });

  it('does not require digest for quality checking', async () => {
    // Quality check uses raw body, not digest
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1, { body: 'asdf test' }));
    // No digest set
    await store.save();

    const mockLLM = createMockLLM({
      results: [{ number: 1, quality: 'test', reason: 'Test submission', suggestedLabel: 'invalid' }],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    const results = await runner.check();

    expect(results.flagged).toHaveLength(1);
    expect(results.flagged[0].flag).toBe('test');
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ openCount: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.check();
    expect(results.message).toContain('already checked');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.check({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as ok', async () => {
    const store = await setupStore({ openCount: 3 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'spam', reason: 'Spam', suggestedLabel: 'invalid' },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    await runner.check();

    // Issues 2 and 3 not returned — should default to ok
    expect(store.getIssue(2)!.analysis.qualityFlag).toBe('ok');
    expect(store.getIssue(2)!.analysis.qualityAnalyzedAt).toBeTruthy();
    expect(store.getIssue(3)!.analysis.qualityFlag).toBe('ok');
  });

  it('uses full issue body in prompt', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1, { body: 'Buy cheap watches at example.com! Best deals!!!' }));
    await store.save();

    const mockLLM = createMockLLM({ results: [] });
    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    await runner.check();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('Buy cheap watches at example.com');
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ openCount: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'spam', reason: 'Spam', suggestedLabel: 'invalid' },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    await runner.check({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('uses default label mapping when suggestedLabel is null', async () => {
    const store = await setupStore({ openCount: 2 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'vague', reason: 'Unclear', suggestedLabel: null },
        { number: 2, quality: 'wrong-language', reason: 'Not English', suggestedLabel: null },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    const results = await runner.check();

    expect(results.flagged[0].suggestedLabel).toBe('needs-info');
    expect(results.flagged[1].suggestedLabel).toBe('invalid');
  });

  it('empty result has correct properties', () => {
    const results = QualityResults.empty('Nothing to check');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('Nothing to check');
    expect(results.flagged).toHaveLength(0);
  });

  it('flagCounts groups items correctly', async () => {
    const store = await setupStore({ openCount: 5 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, quality: 'spam', reason: 'R', suggestedLabel: 'invalid' },
        { number: 2, quality: 'spam', reason: 'R', suggestedLabel: 'invalid' },
        { number: 3, quality: 'vague', reason: 'R', suggestedLabel: 'needs-info' },
        { number: 4, quality: 'test', reason: 'R', suggestedLabel: 'invalid' },
        { number: 5, quality: 'ok', reason: '', suggestedLabel: null },
      ],
    });

    const runner = new QualityRunner(store, makeConfig(), mockLLM);
    const results = await runner.check();

    expect(results.flagCounts).toEqual({
      spam: 2,
      vague: 1,
      test: 1,
    });
  });
});
