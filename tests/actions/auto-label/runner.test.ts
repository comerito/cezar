import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutoLabelRunner, LabelResults } from '../../../src/actions/auto-label/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { GitHubService } from '../../../src/services/github.service.js';
import type { LabelResponse } from '../../../src/actions/auto-label/prompt.js';

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
    labels: [] as string[],
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

const REPO_LABELS = ['bug', 'enhancement', 'area: auth', 'area: api', 'critical', 'documentation'];

function createMockLLM(response: LabelResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

function createMockGitHub(labels: string[] = REPO_LABELS): GitHubService {
  return {
    fetchRepoLabels: vi.fn().mockResolvedValue(labels),
  } as unknown as GitHubService;
}

describe('AutoLabelRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'auto-label-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    count?: number;
    withDigest?: boolean;
    analyzedCount?: number;
    labels?: string[][];
  } = {}): Promise<IssueStore> {
    const { count = 0, withDigest = true, analyzedCount = 0, labels } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    for (let i = 1; i <= count; i++) {
      const issueLabels = labels?.[i - 1] ?? [];
      store.upsertIssue(makeIssueData(i, { labels: issueLabels }));
      if (withDigest) {
        store.setDigest(i, { ...digest, summary: `Summary ${i}` });
      }
      if (i <= analyzedCount) {
        store.setAnalysis(i, { labelsAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    await store.save();
    return store;
  }

  it('detects label suggestions and persists to store', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug', 'area: auth'], reason: 'Auth-related bug' },
        { number: 2, suggested: ['enhancement'], reason: 'Feature request' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.analyze();

    expect(results.suggestions).toHaveLength(2);
    expect(results.suggestions[0].number).toBe(1);
    expect(results.suggestions[0].suggestedLabels).toEqual(['bug', 'area: auth']);
    expect(results.suggestions[0].reason).toBe('Auth-related bug');
    expect(results.suggestions[1].number).toBe(2);
    expect(results.suggestions[1].suggestedLabels).toEqual(['enhancement']);

    // Check store was updated
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.suggestedLabels).toEqual(['bug', 'area: auth']);
    expect(issue1.analysis.labelsReason).toBe('Auth-related bug');
    expect(issue1.analysis.labelsAnalyzedAt).toBeTruthy();
  });

  it('filters suggestions to only valid repo labels', async () => {
    const store = await setupStore({ count: 1 });
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug', 'invented-label', 'area: auth'], reason: 'Test' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.analyze();

    // 'invented-label' should be filtered out
    expect(results.suggestions).toHaveLength(1);
    expect(results.suggestions[0].suggestedLabels).toEqual(['bug', 'area: auth']);
    expect(results.suggestions[0].suggestedLabels).not.toContain('invented-label');
  });

  it('filters out labels already on the issue', async () => {
    const store = await setupStore({ count: 1, labels: [['bug']] });
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug', 'area: api'], reason: 'API bug' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.analyze();

    // 'bug' already on issue, only 'area: api' should be suggested
    expect(results.suggestions).toHaveLength(1);
    expect(results.suggestions[0].suggestedLabels).toEqual(['area: api']);
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ count: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ labels: [] });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);

    // Without recheck — should return early
    const results = await runner.analyze();
    expect(results.message).toContain('already analyzed');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.analyze({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ count: 3 });
    // LLM only returns result for issue 1
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug'], reason: 'Bug report' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    await runner.analyze();

    // All 3 should be marked as analyzed
    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.labelsAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.labelBatchSize = 2;

    const store = await setupStore({ count: 5 });
    const mockLLM = createMockLLM({ labels: [] });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, config, mockLLM, mockGitHub);
    await runner.analyze();

    // 5 issues / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ count: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug'], reason: 'Test' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    await runner.analyze({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = LabelResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('returns empty when repo has no labels', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({ labels: [] });
    const mockGitHub = createMockGitHub([]);

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.analyze();

    expect(results.isEmpty).toBe(true);
    expect(results.message).toContain('No labels defined');
    expect(mockLLM.analyze).not.toHaveBeenCalled();
  });

  it('returns no suggestions when all labels would be filtered out', async () => {
    // Issue already has all the labels LLM suggests
    const store = await setupStore({ count: 1, labels: [['bug', 'area: auth']] });
    const mockLLM = createMockLLM({
      labels: [
        { number: 1, suggested: ['bug', 'area: auth'], reason: 'Already labeled' },
      ],
    });
    const mockGitHub = createMockGitHub();

    const runner = new AutoLabelRunner(store, makeConfig(), mockLLM, mockGitHub);
    const results = await runner.analyze();

    expect(results.suggestions).toHaveLength(0);

    // But the issue should still be marked as analyzed
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.labelsAnalyzedAt).toBeTruthy();
    expect(issue1.analysis.suggestedLabels).toBeNull();
  });
});
