import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecurringQuestionRunner, RecurringQuestionResults } from '../../../src/actions/recurring-questions/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { RecurringQuestionResponse } from '../../../src/actions/recurring-questions/prompt.js';

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

const questionDigest = {
  summary: 'A test question',
  category: 'question' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

const bugDigest = {
  summary: 'A test bug',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

const closedDigest = {
  summary: 'Answered question',
  category: 'question' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

function createMockLLM(response: RecurringQuestionResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('RecurringQuestionRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'recurring-q-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    openQuestions?: number;
    openBugs?: number;
    closedIssues?: number;
    analyzedQuestions?: number;
  } = {}): Promise<IssueStore> {
    const { openQuestions = 0, openBugs = 0, closedIssues = 0, analyzedQuestions = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < openQuestions; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...questionDigest, summary: `Question ${num}` });
      if (i < analyzedQuestions) {
        store.setAnalysis(num, { recurringAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < openBugs; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...bugDigest, summary: `Bug ${num}` });
    }

    for (let i = 0; i < closedIssues; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
      store.setDigest(num, { ...closedDigest, summary: `Closed answer ${num}` });
    }

    await store.save();
    return store;
  }

  it('detects recurring questions and persists to store', async () => {
    const store = await setupStore({ openQuestions: 3, closedIssues: 2 });
    const mockLLM = createMockLLM({
      questions: [
        { number: 1, isRecurring: true, similarClosedIssues: [4, 5], suggestedResponse: 'See #4 and #5', confidence: 0.9 },
        { number: 2, isRecurring: false, similarClosedIssues: [], suggestedResponse: '', confidence: 0 },
      ],
    });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(1);
    expect(results.items[0].similarClosedIssues).toHaveLength(2);
    expect(results.items[0].similarClosedIssues[0].number).toBe(4);
    expect(results.items[0].suggestedResponse).toBe('See #4 and #5');
    expect(results.items[0].confidence).toBe(0.9);

    // Check store was updated for recurring
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.isRecurringQuestion).toBe(true);
    expect(issue1.analysis.similarClosedIssues).toEqual([4, 5]);
    expect(issue1.analysis.suggestedResponse).toBe('See #4 and #5');
    expect(issue1.analysis.recurringAnalyzedAt).toBeTruthy();

    // Non-recurring should still be marked analyzed
    const issue2 = store.getIssue(2)!;
    expect(issue2.analysis.isRecurringQuestion).toBe(false);
    expect(issue2.analysis.recurringAnalyzedAt).toBeTruthy();
  });

  it('only analyzes question-category issues', async () => {
    const store = await setupStore({ openQuestions: 2, openBugs: 3, closedIssues: 1 });
    const mockLLM = createMockLLM({ questions: [] });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    await runner.detect();

    // LLM should only receive the 2 questions, not the 3 bugs
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).not.toContain('#3');
  });

  it('skips already-analyzed questions unless --recheck', async () => {
    const store = await setupStore({ openQuestions: 3, closedIssues: 1, analyzedQuestions: 3 });
    const mockLLM = createMockLLM({ questions: [] });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.detect();
    expect(results.message).toContain('already checked');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.detect({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('returns early when no closed issues exist', async () => {
    const store = await setupStore({ openQuestions: 3, closedIssues: 0 });
    const mockLLM = createMockLLM({ questions: [] });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.message).toContain('No closed issues');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ openQuestions: 3, closedIssues: 1 });
    // LLM only returns result for issue 1
    const mockLLM = createMockLLM({
      questions: [
        { number: 1, isRecurring: false, similarClosedIssues: [], suggestedResponse: '', confidence: 0 },
      ],
    });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    await runner.detect();

    // All 3 questions should be marked as analyzed
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.recurringAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.recurringBatchSize = 2;

    const store = await setupStore({ openQuestions: 5, closedIssues: 1 });
    const mockLLM = createMockLLM({ questions: [] });

    const runner = new RecurringQuestionRunner(store, config, mockLLM);
    await runner.detect();

    // 5 questions / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ openQuestions: 2, closedIssues: 1 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      questions: [
        { number: 1, isRecurring: true, similarClosedIssues: [3], suggestedResponse: 'See #3', confidence: 0.85 },
      ],
    });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    await runner.detect({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = RecurringQuestionResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('returns empty when no questions exist', async () => {
    const store = await setupStore({ openBugs: 5, closedIssues: 2 });
    const mockLLM = createMockLLM({ questions: [] });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.message).toContain('already checked');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('resolves closed issue titles in results', async () => {
    const store = await setupStore({ openQuestions: 1, closedIssues: 1 });
    const mockLLM = createMockLLM({
      questions: [
        { number: 1, isRecurring: true, similarClosedIssues: [2], suggestedResponse: 'See #2', confidence: 0.9 },
      ],
    });

    const runner = new RecurringQuestionRunner(store, makeConfig(), mockLLM);
    const results = await runner.detect();

    expect(results.items[0].similarClosedIssues[0].title).toBe('Issue 2');
  });
});
