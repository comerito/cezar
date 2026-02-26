import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DoneDetectorRunner, DoneDetectorResults } from '../../../src/actions/done-detector/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { GitHubService, TimelineCrossReference } from '../../../src/services/github.service.js';
import type { DoneDetectorResponse } from '../../../src/actions/done-detector/prompt.js';

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '' },
    sync: {
      digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false,
      labelBatchSize: 20, missingInfoBatchSize: 15, recurringBatchSize: 15,
      priorityBatchSize: 20, securityBatchSize: 20, staleDaysThreshold: 90, staleCloseDays: 14,
      doneDetectorBatchSize: 10,
    },
  };
}

const digest = {
  summary: 'A test issue',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

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
    updatedAt: '2024-06-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: contentHash(title, body),
    commentCount: 0,
    reactions: 0,
    ...overrides,
  };
}

function createMockLLM(response: DoneDetectorResponse | null): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

function createMockGitHub(timelineMap: Record<number, TimelineCrossReference[]>): GitHubService {
  return {
    getIssueTimeline: vi.fn().mockImplementation((issueNumber: number) => {
      return Promise.resolve(timelineMap[issueNumber] ?? []);
    }),
  } as unknown as GitHubService;
}

describe('DoneDetectorRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'done-detector-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(issueCount: number, opts: { analyzedCount?: number; closedCount?: number } = {}): Promise<IssueStore> {
    const { analyzedCount = 0, closedCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < issueCount; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...digest, summary: `Issue ${num} summary` });
      if (i < analyzedCount) {
        store.setAnalysis(num, { doneAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
      store.setDigest(num, digest);
    }

    await store.save();
    return store;
  }

  it('full flow: fetches timelines, sends to LLM, stores results', async () => {
    const store = await setupStore(3);

    const mockGitHub = createMockGitHub({
      1: [{ prNumber: 101, prTitle: 'Fix #1 bug', prUrl: 'https://github.com/test/repo/pull/101', merged: true }],
      2: [{ prNumber: 102, prTitle: 'Update related code', prUrl: 'https://github.com/test/repo/pull/102', merged: true }],
      3: [], // no merged PRs
    });

    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.95, reason: 'PR #101 explicitly fixes issue #1', draftComment: 'Resolved by PR #101.' },
        { number: 2, isDone: false, confidence: 0.4, reason: 'PR #102 is only tangentially related', draftComment: '' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    // Issue 3 has no merged PRs — should be marked not done without LLM
    expect(store.getIssue(3)!.analysis.doneDetected).toBe(false);
    expect(store.getIssue(3)!.analysis.doneAnalyzedAt).toBeTruthy();
    expect(store.getIssue(3)!.analysis.doneMergedPRs).toBeNull();

    // Issues 1 and 2 went through LLM
    expect(results.items).toHaveLength(2);
    expect(results.resolved).toHaveLength(1);
    expect(results.resolved[0].number).toBe(1);
    expect(results.resolved[0].confidence).toBe(0.95);

    // Store persistence
    expect(store.getIssue(1)!.analysis.doneDetected).toBe(true);
    expect(store.getIssue(1)!.analysis.doneConfidence).toBe(0.95);
    expect(store.getIssue(1)!.analysis.doneMergedPRs).toEqual([{ prNumber: 101, prTitle: 'Fix #1 bug' }]);
    expect(store.getIssue(1)!.analysis.doneAnalyzedAt).toBeTruthy();

    expect(store.getIssue(2)!.analysis.doneDetected).toBe(false);
  });

  it('returns empty when no open issues exist', async () => {
    const store = await setupStore(0);
    const mockGitHub = createMockGitHub({});
    const mockLLM = createMockLLM(null);

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No open issues');
    expect(mockGitHub.getIssueTimeline).not.toHaveBeenCalled();
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('no-merged-PRs path: marks all issues as not done without calling LLM', async () => {
    const store = await setupStore(3);
    const mockGitHub = createMockGitHub({
      1: [],
      2: [],
      3: [],
    });
    const mockLLM = createMockLLM(null);

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    expect(results.items).toHaveLength(0);
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // All issues should be marked as analyzed with doneDetected=false
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.doneDetected).toBe(false);
      expect(store.getIssue(i)!.analysis.doneAnalyzedAt).toBeTruthy();
    }
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore(3, { analyzedCount: 3 });
    const mockGitHub = createMockGitHub({});
    const mockLLM = createMockLLM({ results: [] });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);

    // Without recheck
    const results = await runner.detect();
    expect(results.message).toContain('already checked');
    expect(mockGitHub.getIssueTimeline).not.toHaveBeenCalled();

    // With recheck
    const mockGitHub2 = createMockGitHub({ 1: [], 2: [], 3: [] });
    const runner2 = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub2);
    await runner2.detect({ recheck: true });
    expect(mockGitHub2.getIssueTimeline).toHaveBeenCalledTimes(3);
  });

  it('dry run does not save store', async () => {
    const store = await setupStore(2);
    const saveSpy = vi.spyOn(store, 'save');

    const mockGitHub = createMockGitHub({
      1: [{ prNumber: 101, prTitle: 'Fix #1', prUrl: 'url', merged: true }],
      2: [],
    });
    const mockLLM = createMockLLM({
      results: [{ number: 1, isDone: true, confidence: 0.9, reason: 'Fixed', draftComment: 'Done' }],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    await runner.detect({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('handles LLM fallback for missing results', async () => {
    const store = await setupStore(3);
    const mockGitHub = createMockGitHub({
      1: [{ prNumber: 101, prTitle: 'Fix #1', prUrl: 'url', merged: true }],
      2: [{ prNumber: 102, prTitle: 'Fix #2', prUrl: 'url', merged: true }],
      3: [{ prNumber: 103, prTitle: 'Fix #3', prUrl: 'url', merged: true }],
    });

    // LLM only returns result for issue 1, skipping 2 and 3
    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.95, reason: 'Fixed', draftComment: 'Done' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    await runner.detect();

    // Issues 2 and 3 should be marked as not done (fallback)
    expect(store.getIssue(2)!.analysis.doneDetected).toBe(false);
    expect(store.getIssue(2)!.analysis.doneReason).toBe('No suggestion from analysis');
    expect(store.getIssue(2)!.analysis.doneAnalyzedAt).toBeTruthy();

    expect(store.getIssue(3)!.analysis.doneDetected).toBe(false);
  });

  it('empty DoneDetectorResults has correct properties', () => {
    const results = DoneDetectorResults.empty('Test message');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('Test message');
    expect(results.items).toHaveLength(0);
    expect(results.resolved).toHaveLength(0);
  });

  it('timeline error resilience: skips issues with failed timeline fetches', async () => {
    const store = await setupStore(3);

    // Issue 2 timeline fetch throws an error
    const mockGitHub = {
      getIssueTimeline: vi.fn().mockImplementation((issueNumber: number) => {
        if (issueNumber === 2) return Promise.reject(new Error('API error'));
        if (issueNumber === 1) return Promise.resolve([{ prNumber: 101, prTitle: 'Fix #1', prUrl: 'url', merged: true }]);
        return Promise.resolve([]);
      }),
    } as unknown as GitHubService;

    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.9, reason: 'Fixed', draftComment: 'Done' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    // Issue 1 should be assessed, issue 2 skipped (error), issue 3 marked no PRs
    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(1);

    // Issue 2 should NOT have doneAnalyzedAt set (was skipped due to error)
    expect(store.getIssue(2)!.analysis.doneAnalyzedAt).toBeNull();

    // Issue 3 should be marked as no merged PRs
    expect(store.getIssue(3)!.analysis.doneDetected).toBe(false);
  });

  it('handles multiple merged PRs for a single issue', async () => {
    const store = await setupStore(1);

    const mockGitHub = createMockGitHub({
      1: [
        { prNumber: 101, prTitle: 'Partial fix for #1', prUrl: 'url1', merged: true },
        { prNumber: 102, prTitle: 'Complete fix for #1', prUrl: 'url2', merged: true },
      ],
    });

    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.92, reason: 'PRs #101 and #102 together resolve the issue', draftComment: 'Resolved by PRs #101 and #102.' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    expect(results.items).toHaveLength(1);
    expect(results.items[0].mergedPRs).toHaveLength(2);
    expect(store.getIssue(1)!.analysis.doneMergedPRs).toEqual([
      { prNumber: 101, prTitle: 'Partial fix for #1' },
      { prNumber: 102, prTitle: 'Complete fix for #1' },
    ]);
  });

  it('results are sorted: resolved first, by confidence descending', async () => {
    const store = await setupStore(3);

    const mockGitHub = createMockGitHub({
      1: [{ prNumber: 101, prTitle: 'PR 101', prUrl: 'url', merged: true }],
      2: [{ prNumber: 102, prTitle: 'PR 102', prUrl: 'url', merged: true }],
      3: [{ prNumber: 103, prTitle: 'PR 103', prUrl: 'url', merged: true }],
    });

    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.80, reason: 'Likely fixed', draftComment: 'Done' },
        { number: 2, isDone: false, confidence: 0.40, reason: 'Not related', draftComment: '' },
        { number: 3, isDone: true, confidence: 0.95, reason: 'Clearly fixed', draftComment: 'Done' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.detect();

    // Resolved first (sorted by confidence desc), then not-resolved
    expect(results.items[0].number).toBe(3); // 0.95
    expect(results.items[1].number).toBe(1); // 0.80
    expect(results.items[2].number).toBe(2); // not done
  });

  it('only sends issues with merged PRs to LLM prompt', async () => {
    const store = await setupStore(4);

    const mockGitHub = createMockGitHub({
      1: [{ prNumber: 101, prTitle: 'Fix #1', prUrl: 'url', merged: true }],
      2: [], // no PRs
      3: [{ prNumber: 103, prTitle: 'Fix #3', prUrl: 'url', merged: true }],
      4: [], // no PRs
    });

    const mockLLM = createMockLLM({
      results: [
        { number: 1, isDone: true, confidence: 0.9, reason: 'Fixed', draftComment: 'Done' },
        { number: 3, isDone: true, confidence: 0.85, reason: 'Fixed', draftComment: 'Done' },
      ],
    });

    const runner = new DoneDetectorRunner(store, makeConfig(), mockLLM, mockGitHub);
    await runner.detect();

    // LLM should only be called once with issues 1 and 3
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1 — Issue 1');
    expect(prompt).toContain('#3 — Issue 3');
    expect(prompt).not.toContain('#2 — Issue 2');
    expect(prompt).not.toContain('#4 — Issue 4');
  });
});
