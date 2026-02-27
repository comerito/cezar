import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IssueStore } from '../../src/store/store.js';
import { contentHash } from '../../src/utils/hash.js';
import { isCloseFlagged, getCloseFlaggedIssueNumbers, applyPipelineExclusions } from '../../src/pipeline/close-flag.js';
import type { StoredIssue } from '../../src/store/store.model.js';

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

const digest = {
  summary: 'A test issue',
  category: 'bug' as const,
  affectedArea: 'core',
  keywords: ['test'],
  digestedAt: '2024-01-01T00:00:00Z',
};

describe('isCloseFlagged', () => {
  it('returns true when issue has duplicateOf set', () => {
    const issue = { analysis: { duplicateOf: 42, doneDetected: null } } as unknown as StoredIssue;
    expect(isCloseFlagged(issue)).toBe(true);
  });

  it('returns true when issue has doneDetected === true', () => {
    const issue = { analysis: { duplicateOf: null, doneDetected: true } } as unknown as StoredIssue;
    expect(isCloseFlagged(issue)).toBe(true);
  });

  it('returns true when both flags are set', () => {
    const issue = { analysis: { duplicateOf: 10, doneDetected: true } } as unknown as StoredIssue;
    expect(isCloseFlagged(issue)).toBe(true);
  });

  it('returns false when neither flag is set', () => {
    const issue = { analysis: { duplicateOf: null, doneDetected: null } } as unknown as StoredIssue;
    expect(isCloseFlagged(issue)).toBe(false);
  });

  it('returns false when doneDetected is explicitly false', () => {
    const issue = { analysis: { duplicateOf: null, doneDetected: false } } as unknown as StoredIssue;
    expect(isCloseFlagged(issue)).toBe(false);
  });
});

describe('getCloseFlaggedIssueNumbers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'close-flag-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty set when no issues are flagged', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.setDigest(1, digest);

    const flagged = getCloseFlaggedIssueNumbers(store);
    expect(flagged.size).toBe(0);
  });

  it('returns issue numbers flagged as duplicates', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.upsertIssue(makeIssueData(2));
    store.setDigest(1, digest);
    store.setDigest(2, digest);
    store.setAnalysis(1, { duplicateOf: 2, duplicatesAnalyzedAt: '2024-01-01T00:00:00Z' });

    const flagged = getCloseFlaggedIssueNumbers(store);
    expect(flagged).toEqual(new Set([1]));
  });

  it('returns issue numbers flagged as done', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.upsertIssue(makeIssueData(2));
    store.setDigest(1, digest);
    store.setDigest(2, digest);
    store.setAnalysis(2, { doneDetected: true, doneAnalyzedAt: '2024-01-01T00:00:00Z' });

    const flagged = getCloseFlaggedIssueNumbers(store);
    expect(flagged).toEqual(new Set([2]));
  });

  it('ignores closed issues', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1, { state: 'closed' }));
    store.setDigest(1, digest);
    store.setAnalysis(1, { duplicateOf: 5 });

    const flagged = getCloseFlaggedIssueNumbers(store);
    expect(flagged.size).toBe(0);
  });

  it('returns combined set of duplicates and done issues', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.upsertIssue(makeIssueData(2));
    store.upsertIssue(makeIssueData(3));
    store.setDigest(1, digest);
    store.setDigest(2, digest);
    store.setDigest(3, digest);
    store.setAnalysis(1, { duplicateOf: 3 });
    store.setAnalysis(2, { doneDetected: true });

    const flagged = getCloseFlaggedIssueNumbers(store);
    expect(flagged).toEqual(new Set([1, 2]));
  });
});

describe('applyPipelineExclusions', () => {
  const candidates = [
    { number: 1, title: 'Issue 1' },
    { number: 2, title: 'Issue 2' },
    { number: 3, title: 'Issue 3' },
    { number: 4, title: 'Issue 4' },
  ];

  it('returns all candidates when excludeIssues is undefined', () => {
    const result = applyPipelineExclusions(candidates, {});
    expect(result).toEqual(candidates);
  });

  it('returns all candidates when excludeIssues is empty', () => {
    const result = applyPipelineExclusions(candidates, { excludeIssues: new Set<number>() });
    expect(result).toEqual(candidates);
  });

  it('filters out excluded issues', () => {
    const result = applyPipelineExclusions(candidates, {
      excludeIssues: new Set([2, 4]),
    });
    expect(result).toEqual([
      { number: 1, title: 'Issue 1' },
      { number: 3, title: 'Issue 3' },
    ]);
  });

  it('handles excludeIssues that reference non-existent candidates', () => {
    const result = applyPipelineExclusions(candidates, {
      excludeIssues: new Set([99]),
    });
    expect(result).toEqual(candidates);
  });

  it('returns empty array when all candidates are excluded', () => {
    const result = applyPipelineExclusions(candidates, {
      excludeIssues: new Set([1, 2, 3, 4]),
    });
    expect(result).toEqual([]);
  });
});
