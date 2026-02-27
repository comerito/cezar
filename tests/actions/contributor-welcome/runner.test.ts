import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContributorWelcomeRunner, WelcomeResults, findFirstTimeAuthors } from '../../../src/actions/contributor-welcome/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { WelcomeResponse } from '../../../src/actions/contributor-welcome/prompt.js';

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
    author: `user${number}`,
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

function createMockLLM(response: WelcomeResponse | null): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('ContributorWelcomeRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'welcome-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    firstTimeCount?: number;
    returningCount?: number;
    welcomedCount?: number;
  } = {}): Promise<IssueStore> {
    const { firstTimeCount = 0, returningCount = 0, welcomedCount = 0 } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    let num = 1;

    // First-time contributors: each has a unique author with only 1 issue
    for (let i = 0; i < firstTimeCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { author: `newbie${i}` }));
      store.setDigest(num, { ...digest, summary: `First time issue ${num}` });
      if (i < welcomedCount) {
        store.setAnalysis(num, { welcomeCommentPostedAt: '2024-01-02T00:00:00Z' });
      }
    }

    // Returning contributors: same author for multiple issues
    for (let i = 0; i < returningCount; i++, num++) {
      store.upsertIssue(makeIssueData(num, { author: 'veteran' }));
      store.setDigest(num, { ...digest, summary: `Returning user issue ${num}` });
    }

    // Add a closed issue from 'veteran' to make them clearly returning
    if (returningCount > 0) {
      num++;
      store.upsertIssue(makeIssueData(num, { author: 'veteran', state: 'closed' }));
      store.setDigest(num, digest);
    }

    await store.save();
    return store;
  }

  it('identifies first-time contributors and generates welcome messages', async () => {
    const store = await setupStore({ firstTimeCount: 2, returningCount: 1 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, welcomeMessage: 'Welcome newbie0!' },
        { number: 2, welcomeMessage: 'Welcome newbie1!' },
      ],
    });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.candidates).toHaveLength(2);
    expect(results.candidates[0].author).toBe('newbie0');
    expect(results.candidates[0].welcomeMessage).toBe('Welcome newbie0!');
    expect(results.candidates[1].author).toBe('newbie1');
  });

  it('excludes returning contributors', async () => {
    const store = await setupStore({ firstTimeCount: 1, returningCount: 2 });
    const mockLLM = createMockLLM({
      results: [
        { number: 1, welcomeMessage: 'Welcome!' },
      ],
    });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    // Only first-time contributor should be in prompt, not veteran
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('@newbie0');
    expect(prompt).not.toContain('@veteran');
  });

  it('skips already-welcomed contributors unless --recheck', async () => {
    const store = await setupStore({ firstTimeCount: 2, welcomedCount: 2 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);

    // Without recheck — should skip
    const results = await runner.analyze();
    expect(results.message).toContain('already welcomed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.analyze({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('returns empty when no first-time contributors exist', async () => {
    const store = await setupStore({ returningCount: 3 });
    const mockLLM = createMockLLM(null);

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No first-time contributors');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('returns empty when no open issues exist', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    await store.save();

    const mockLLM = createMockLLM(null);
    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.isEmpty).toBe(true);
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ firstTimeCount: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      results: [
        { number: 1, welcomeMessage: 'Welcome!' },
      ],
    });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    await runner.analyze({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('includes issue category in results', async () => {
    const store = await setupStore({ firstTimeCount: 0 });
    store.upsertIssue(makeIssueData(1, { author: 'newdev' }));
    store.setDigest(1, { ...digest, category: 'feature' as const, summary: 'Feature request' });
    await store.save();

    const mockLLM = createMockLLM({
      results: [{ number: 1, welcomeMessage: 'Thanks for the feature idea!' }],
    });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    const results = await runner.analyze();

    expect(results.candidates[0].category).toBe('feature');
  });

  it('includes repo name in prompt for context', async () => {
    const store = await setupStore({ firstTimeCount: 1 });
    const mockLLM = createMockLLM({ results: [] });

    const runner = new ContributorWelcomeRunner(store, makeConfig(), mockLLM);
    await runner.analyze();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('test/repo');
  });

  it('empty result has correct properties', () => {
    const results = WelcomeResults.empty('No one to welcome');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No one to welcome');
    expect(results.candidates).toHaveLength(0);
  });
});

describe('findFirstTimeAuthors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fta-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('identifies authors with exactly one issue', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    // newbie has 1 issue, veteran has 2
    store.upsertIssue(makeIssueData(1, { author: 'newbie' }));
    store.upsertIssue(makeIssueData(2, { author: 'veteran' }));
    store.upsertIssue(makeIssueData(3, { author: 'veteran' }));
    await store.save();

    const firstTimers = findFirstTimeAuthors(store);
    expect(firstTimers.has('newbie')).toBe(true);
    expect(firstTimers.has('veteran')).toBe(false);
  });

  it('counts closed issues toward author history', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    // user has one open and one closed — not first-time
    store.upsertIssue(makeIssueData(1, { author: 'user1' }));
    store.upsertIssue(makeIssueData(2, { author: 'user1', state: 'closed' }));
    await store.save();

    const firstTimers = findFirstTimeAuthors(store);
    expect(firstTimers.has('user1')).toBe(false);
  });
});
