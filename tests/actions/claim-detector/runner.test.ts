import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaimDetectorRunner, ClaimDetectorResults } from '../../../src/actions/claim-detector/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';

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

type Comment = { author: string; body: string; createdAt: string };

function makeIssueData(number: number, overrides: Record<string, unknown> = {}) {
  const title = `Issue ${number}`;
  const body = `Body for issue ${number}`;
  return {
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    assignees: [] as string[],
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

describe('ClaimDetectorRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'claim-detector-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(
    issueCount: number,
    opts: { analyzedCount?: number; closedCount?: number; commentsMap?: Record<number, Comment[]> } = {},
  ): Promise<IssueStore> {
    const { analyzedCount = 0, closedCount = 0, commentsMap = {} } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < issueCount; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      if (commentsMap[num]) {
        store.setComments(num, commentsMap[num]);
      }
      if (i < analyzedCount) {
        store.setAnalysis(num, { claimDetectedAt: '2024-01-01T00:00:00Z' });
      }
    }

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'closed' }));
      if (commentsMap[num]) {
        store.setComments(num, commentsMap[num]);
      }
    }

    await store.save();
    return store;
  }

  it('full flow: reads stored comments, detects claims, stores results', async () => {
    const store = await setupStore(3, {
      commentsMap: {
        1: [{ author: 'gsobczyk', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }],
        2: [{ author: 'reviewer', body: 'Looks like a valid issue', createdAt: '2024-06-01T10:00:00Z' }],
        3: [{ author: 'dev42', body: "I'll work on this", createdAt: '2024-06-01T11:00:00Z' }],
      },
    });

    const runner = new ClaimDetectorRunner(store, makeConfig());
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

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No open issues');
  });

  it('no-claims path: marks all issues as analyzed with no claim', async () => {
    const store = await setupStore(2, {
      commentsMap: {
        1: [{ author: 'someone', body: 'Nice feature!', createdAt: '2024-06-01T10:00:00Z' }],
        2: [],
      },
    });

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);

    for (let i = 1; i <= 2; i++) {
      expect(store.getIssue(i)!.analysis.claimDetectedBy).toBeNull();
      expect(store.getIssue(i)!.analysis.claimDetectedAt).toBeTruthy();
    }
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore(3, { analyzedCount: 3 });

    const runner = new ClaimDetectorRunner(store, makeConfig());

    // Without recheck
    const results = await runner.detect();
    expect(results.message).toContain('already checked');

    // With recheck — all issues scanned
    const runner2 = new ClaimDetectorRunner(store, makeConfig());
    const results2 = await runner2.detect({ recheck: true });
    expect(results2.isEmpty).toBe(true); // no claims since no comments
  });

  it('dry run does not save store', async () => {
    const store = await setupStore(2, {
      commentsMap: {
        1: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }],
        2: [],
      },
    });
    const saveSpy = vi.spyOn(store, 'save');

    const runner = new ClaimDetectorRunner(store, makeConfig());
    await runner.detect({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('negative patterns excluded: "take a look" is not a claim', async () => {
    const store = await setupStore(1, {
      commentsMap: {
        1: [{ author: 'reviewer', body: "I'll take a look at this", createdAt: '2024-06-01T10:00:00Z' }],
      },
    });

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    expect(results.isEmpty).toBe(true);
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBeNull();
  });

  it('skips issues where claimant is already assigned', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1, { assignees: ['gsobczyk'] }));
    store.upsertIssue(makeIssueData(2));
    store.setComments(1, [{ author: 'gsobczyk', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }]);
    store.setComments(2, [{ author: 'dev42', body: "I'll work on this", createdAt: '2024-06-01T10:00:00Z' }]);
    await store.save();

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    // Issue 1 should NOT appear in results (already assigned)
    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(2);

    // But issue 1 should still be marked as analyzed
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBe('gsobczyk');
    expect(store.getIssue(1)!.analysis.claimDetectedAt).toBeTruthy();
  });

  it('multiple claims: latest wins', async () => {
    const store = await setupStore(1, {
      commentsMap: {
        1: [
          { author: 'first_dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' },
          { author: 'second_dev', body: "I'll work on this", createdAt: '2024-06-02T10:00:00Z' },
        ],
      },
    });

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    expect(results.items).toHaveLength(1);
    expect(results.items[0].claimant).toBe('second_dev');
    expect(store.getIssue(1)!.analysis.claimDetectedBy).toBe('second_dev');
  });

  it('only scans open issues (not closed)', async () => {
    const store = await setupStore(2, {
      closedCount: 1,
      commentsMap: {
        1: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }],
        2: [],
        3: [{ author: 'dev', body: "I'll take it", createdAt: '2024-06-01T10:00:00Z' }], // closed issue
      },
    });

    const runner = new ClaimDetectorRunner(store, makeConfig());
    const results = await runner.detect();

    // Only open issues scanned
    expect(results.items).toHaveLength(1);
    expect(results.items[0].number).toBe(1);
  });

  it('re-analyzes issues with updated comments', async () => {
    const store = await setupStore(2, {
      commentsMap: {
        1: [],
        2: [],
      },
    });

    // First run — no claims, marks all as analyzed
    const runner1 = new ClaimDetectorRunner(store, makeConfig());
    const results1 = await runner1.detect();
    expect(results1.isEmpty).toBe(true);

    // Simulate new comments fetched after analysis
    store.setComments(1, [{ author: 'dev', body: "I'll take it", createdAt: '2024-07-01T10:00:00Z' }]);
    await store.save();

    // Second run — should pick up issue 1 as comment-updated
    const runner2 = new ClaimDetectorRunner(store, makeConfig());
    const results2 = await runner2.detect();
    expect(results2.items).toHaveLength(1);
    expect(results2.items[0].number).toBe(1);
    expect(results2.items[0].claimant).toBe('dev');
  });

  it('empty ClaimDetectorResults has correct properties', () => {
    const results = ClaimDetectorResults.empty('Test message');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('Test message');
    expect(results.items).toHaveLength(0);
    expect(results.claimed).toHaveLength(0);
  });
});
