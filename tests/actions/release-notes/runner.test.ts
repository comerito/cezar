import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReleaseNotesRunner, ReleaseNotesResult } from '../../../src/actions/release-notes/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { ReleaseNotesResponse } from '../../../src/actions/release-notes/prompt.js';

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
    state: 'closed' as const,
    labels: [],
    author: `user${number}`,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-02-15T00:00:00Z',
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

const sampleResponse: ReleaseNotesResponse = {
  sections: [
    {
      heading: 'Bug Fixes',
      emoji: '🐛',
      items: [
        { description: 'Fixed login crash on Safari', issues: [1, 2] },
        { description: 'Resolved cart total calculation', issues: [3] },
      ],
    },
    {
      heading: 'New Features',
      emoji: '✨',
      items: [
        { description: 'Added dark mode support', issues: [4] },
      ],
    },
  ],
  contributors: [
    { username: 'user1', isFirstTime: false },
    { username: 'user3', isFirstTime: true },
  ],
};

function createMockLLM(response: ReleaseNotesResponse | null = sampleResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('ReleaseNotesRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T10:00:00Z'));
    tmpDir = await mkdtemp(join(tmpdir(), 'release-notes-test-'));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    closedCount?: number;
    openCount?: number;
  } = {}): Promise<IssueStore> {
    const { closedCount = 0, openCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    for (let i = 0; i < closedCount; i++, num++) {
      store.upsertIssue(makeIssueData(num));
      store.setDigest(num, { ...digest, summary: `Fix ${num}` });
    }

    for (let i = 0; i < openCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { state: 'open' }));
      store.setDigest(num, { ...digest, summary: `Open ${num}` });
    }

    await store.save();
    return store;
  }

  it('generates release notes markdown from closed issues', async () => {
    const store = await setupStore({ closedCount: 4 });
    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate();

    expect(result.issueCount).toBe(4);
    expect(result.isEmpty).toBe(false);
    expect(result.markdown).toContain('Release Notes — 2026-03-15');
    expect(result.markdown).toContain('### 🐛 Bug Fixes');
    expect(result.markdown).toContain('Fixed login crash on Safari (#1, #2)');
    expect(result.markdown).toContain('Resolved cart total calculation (#3)');
    expect(result.markdown).toContain('### ✨ New Features');
    expect(result.markdown).toContain('Added dark mode support (#4)');
    expect(result.markdown).toContain('### Contributors');
    expect(result.markdown).toContain('@user1');
    expect(result.markdown).toContain('@user3 *(first contribution!)*');
  });

  it('uses version tag in title when provided', async () => {
    const store = await setupStore({ closedCount: 2 });
    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate({ versionTag: 'v2.4.0' });

    expect(result.markdown).toContain('## v2.4.0 — 2026-03-15');
  });

  it('filters by date range using since/until', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    // Issue 1: updated in January (outside range)
    store.upsertIssue(makeIssueData(1, { updatedAt: '2024-01-10T00:00:00Z' }));
    store.setDigest(1, { ...digest, summary: 'Old fix' });
    // Issue 2: updated in February (inside range)
    store.upsertIssue(makeIssueData(2, { updatedAt: '2024-02-15T00:00:00Z' }));
    store.setDigest(2, { ...digest, summary: 'New fix' });
    // Issue 3: updated in March (outside range)
    store.upsertIssue(makeIssueData(3, { updatedAt: '2024-03-20T00:00:00Z' }));
    store.setDigest(3, { ...digest, summary: 'Future fix' });
    await store.save();

    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate({
      since: '2024-02-01T00:00:00Z',
      until: '2024-02-28T23:59:59Z',
    });

    expect(result.issueCount).toBe(1);

    // Verify only issue 2 was sent to LLM
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#2');
    expect(prompt).not.toContain('#1');
    expect(prompt).not.toContain('#3');
  });

  it('filters by specific issue numbers', async () => {
    const store = await setupStore({ closedCount: 5 });
    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate({ issues: [2, 4] });

    expect(result.issueCount).toBe(2);

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#2');
    expect(prompt).toContain('#4');
    expect(prompt).not.toContain('#1');
    expect(prompt).not.toContain('#3');
    expect(prompt).not.toContain('#5');
  });

  it('returns empty when no closed issues exist', async () => {
    const store = await setupStore({ openCount: 3 });
    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate();

    expect(result.isEmpty).toBe(true);
    expect(result.message).toContain('No closed issues');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('returns empty when LLM fails', async () => {
    const store = await setupStore({ closedCount: 3 });
    const mockLLM = createMockLLM(null);

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate();

    expect(result.isEmpty).toBe(true);
    expect(result.message).toContain('LLM failed');
  });

  it('empty result has correct properties', () => {
    const result = ReleaseNotesResult.empty('No work needed');
    expect(result.isEmpty).toBe(true);
    expect(result.message).toBe('No work needed');
    expect(result.markdown).toBe('');
  });

  it('identifies first-time contributors via previous authors', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    // Older closed issue by user1 (not in this release)
    store.upsertIssue(makeIssueData(1, { author: 'user1', updatedAt: '2024-01-01T00:00:00Z' }));
    store.setDigest(1, { ...digest, summary: 'Old fix' });
    // This release: issue 2 by user1, issue 3 by newcomer
    store.upsertIssue(makeIssueData(2, { author: 'user1', updatedAt: '2024-03-01T00:00:00Z' }));
    store.setDigest(2, { ...digest, summary: 'New fix' });
    store.upsertIssue(makeIssueData(3, { author: 'newcomer', updatedAt: '2024-03-02T00:00:00Z' }));
    store.setDigest(3, { ...digest, summary: 'First contribution' });
    await store.save();

    const mockLLM = createMockLLM();

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    await runner.generate({
      issues: [2, 3],
    });

    // Check that the prompt includes user1 as a previously known contributor
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('PREVIOUSLY KNOWN CONTRIBUTORS: user1');
  });

  it('skips empty sections in markdown output', async () => {
    const store = await setupStore({ closedCount: 2 });
    const mockLLM = createMockLLM({
      sections: [
        { heading: 'Bug Fixes', emoji: '🐛', items: [{ description: 'A fix', issues: [1] }] },
        { heading: 'New Features', emoji: '✨', items: [] },
      ],
      contributors: [],
    });

    const runner = new ReleaseNotesRunner(store, makeConfig(), mockLLM);
    const result = await runner.generate();

    expect(result.markdown).toContain('### 🐛 Bug Fixes');
    expect(result.markdown).not.toContain('### ✨ New Features');
    expect(result.markdown).not.toContain('### Contributors');
  });
});
