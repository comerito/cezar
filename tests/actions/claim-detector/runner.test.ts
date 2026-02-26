import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaimDetectorRunner, ClaimDetectorResults } from '../../../src/actions/claim-detector/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { GitHubService } from '../../../src/services/github.service.js';

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

type Comment = { author: string; body: string; createdAt: string };

function createMockGitHub(commentsMap: Record<number, Comment[]>): GitHubService {
  return {
    getIssueComments: vi.fn().mockImplementation((issueNumber: number) => {
      return Promise.resolve(commentsMap[issueNumber] ?? []);
    }),
  } as unknown as GitHubService;
}

describe('ClaimDetectorRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claim-detector-test-'));
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
      if (i < analyzedCount) {
        store.setAnalysis(num, { claimDetectedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
    }

    await store.save();
    return store;
  }

  it('full flow: fetches comments, detects claims, stores results', async () => {
    const store = await setupStore(3);

    const mockGitHub = createMockGitHub({
      1: [
        { author: 'gsobczyk', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' },
      ],
      2: [
        { author: 'reviewer', body: 'Looks like a valid issue', createdAt: '2024-06-01T10:00:00Z' },
      ],
      3: [
        { author: 'dev42', body: "I'll work on this", createdAt: '2024-06-01T11:00:00Z' },
      ],
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    expect(results.items).toHaveLength(2);
    expect(results.claimed).toHaveLength(2);

    // Issue 1: claimed by gsobczyk
    const claim1 = results.items.find(i => i.number === 1)!;
    expect(claim1.claimant).toBe('gsobczyk');
    expect(claim1.snippet).toContain("I'll take it");

    // Issue 3: claimed by dev42
    const claim3 = results.items.find(i => i.number === 3)!;
    expect(claim3.claimant).toBe('dev42');

    // Store persistence
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBe('gsobczyk');
    expect(store.getIssue(1)!.analysis.claimDetectedAt).toBeTruthy();

    // Issue 2: no claim found
    expect(store.getIssue(2)!.analysis.claimDetectedBy).toBeNull();
    expect(store.getIssue(2)!.analysis.claimDetectedAt).toBeTruthy();
  });

  it('returns empty when no open issues exist', async () => {
    const store = await setupStore(0);
    const mockGitHub = createMockGitHub({});

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No open issues');
    expect(mockGitHub.getIssueComments).not.toHaveBeenCalled();
  });

  it('no-claims path: marks all issues as analyzed with no claim', async () => {
    const store = await setupStore(2);
    const mockGitHub = createMockGitHub({
      1: [{ author: 'someone', body: 'Nice feature!', createdAt: '2024-06-01T10:00:00Z' }],
      2: [],
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);

    for (let i = 1; i <= 2; i++) {
      expect(store.getIssue(i)!.analysis.claimDetectedBy).toBeNull();
      expect(store.getIssue(i)!.analysis.claimDetectedAt).toBeTruthy();
    }
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore(3, { analyzedCount: 3 });
    const mockGitHub = createMockGitHub({});

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);

    // Without recheck
    const results = await runner.detect();
    expect(results.message).toContain('already checked');
    expect(mockGitHub.getIssueComments).not.toHaveBeenCalled();

    // With recheck
    const mockGitHub2 = createMockGitHub({ 1: [], 2: [], 3: [] });
    const runner2 = new ClaimDetectorRunner(store, makeConfig(), mockGitHub2);
    await runner2.detect({ recheck: true });
    expect(mockGitHub2.getIssueComments).toHaveBeenCalledTimes(3);
  });

  it('dry run does not save store', async () => {
    const store = await setupStore(2);
    const saveSpy = vi.spyOn(store, 'save');

    const mockGitHub = createMockGitHub({
      1: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }],
      2: [],
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    await runner.detect({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('negative patterns excluded: "take a look" is not a claim', async () => {
    const store = await setupStore(1);
    const mockGitHub = createMockGitHub({
      1: [{ author: 'reviewer', body: "I'll take a look at this", createdAt: '2024-06-01T10:00:00Z' }],
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBeNull();
  });

  it('multiple claims: latest wins', async () => {
    const store = await setupStore(1);
    const mockGitHub = createMockGitHub({
      1: [
        { author: 'first_dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' },
        { author: 'second_dev', body: "I'll work on this", createdAt: '2024-06-02T10:00:00Z' },
      ],
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    expect(results.items).toHaveLength(1);
    expect(results.items[0].claimant).toBe('second_dev');
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBe('second_dev');
  });

  it('comment fetch error resilience: skips issues with failed fetches', async () => {
    const store = await setupStore(3);

    const mockGitHub = {
      getIssueComments: vi.fn().mockImplementation((issueNumber: number) => {
        if (issueNumber === 2) return Promise.reject(new Error('API error'));
        if (issueNumber === 1) {
          return Promise.resolve([
            { author: 'dev', body: "I'll take this", createdAt: '2024-06-01T10:00:00Z' },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as GitHubService;

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    // Issue 1 detected, issue 2 skipped (error), issue 3 no claims
    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(1);

    // Issue 2 should NOT be marked as analyzed (was skipped due to error)
    expect(store.getIssue(2)!.analysis.claimDetectedAt).toBeNull();

    // Issue 3 should be marked as analyzed, no claim
    expect(store.getIssue(3)!.analysis.claimDetectedBy).toBeNull();
    expect(store.getIssue(3)!.analysis.claimDetectedAt).toBeTruthy();
  });

  it('only scans open issues (not closed)', async () => {
    const store = await setupStore(2, { closedCount: 1 });
    const mockGitHub = createMockGitHub({
      1: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }],
      2: [],
      3: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }], // closed issue
    });

    const runner = new ClaimDetectorRunner(store, makeConfig(), mockGitHub);
    const results = await runner.detect();

    // Only open issues scanned
    expect(mockGitHub.getIssueComments).toHaveBeenCalledTimes(2);
    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(1);
  });

  it('empty ClaimDetectorResults has correct properties', () => {
    const results = ClaimDetectorResults.empty('Test message');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('Test message');
    expect(results.items).toHaveLength(0);
    expect(results.claimed).toHaveLength(0);
  });
});
