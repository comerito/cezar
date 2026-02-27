import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IssueStore } from '../../src/store/store.js';
import { contentHash } from '../../src/utils/hash.js';
import { actionRegistry } from '../../src/actions/registry.js';
import { runPipeline } from '../../src/pipeline/pipeline.js';
import type { ActionDefinition } from '../../src/actions/action.interface.js';
import type { Config } from '../../src/models/config.model.js';

function makeConfig(storePath: string): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: storePath },
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

describe('runPipeline', () => {
  let tmpDir: string;
  const originalGetAll = actionRegistry.getAll.bind(actionRegistry);
  const originalGet = actionRegistry.get.bind(actionRegistry);

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'pipeline-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    // Restore registry
    vi.restoreAllMocks();
  });

  function createMockAction(id: string, overrides: Partial<ActionDefinition> = {}): ActionDefinition {
    return {
      id,
      label: id,
      description: `Mock ${id}`,
      icon: '🧪',
      group: 'triage',
      getBadge: () => '1 pending',
      isAvailable: () => true,
      run: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('separates actions into Phase 1 and Phase 2', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    const config = makeConfig(tmpDir);

    const duplicates = createMockAction('duplicates');
    const doneDetector = createMockAction('done-detector');
    const priority = createMockAction('priority');

    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([duplicates, doneDetector, priority]);

    const result = await runPipeline(store, config);

    expect(result.phase1Actions).toEqual(['duplicates', 'done-detector']);
    expect(result.phase2Actions).toEqual(['priority']);
  });

  it('runs Phase 1 actions non-interactively', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    const config = makeConfig(tmpDir);

    const duplicates = createMockAction('duplicates');
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([duplicates]);

    await runPipeline(store, config);

    expect(duplicates.run).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false }),
    );
  });

  it('passes excludeIssues to Phase 2 actions', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.setDigest(1, digest);
    store.setAnalysis(1, { duplicateOf: 2 });

    const config = makeConfig(tmpDir);

    const duplicates = createMockAction('duplicates');
    const priority = createMockAction('priority');
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([duplicates, priority]);

    await runPipeline(store, config);

    expect(priority.run).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          excludeIssues: new Set([1]),
        }),
      }),
    );
  });

  it('skips unavailable actions', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    const config = makeConfig(tmpDir);

    const unavailable = createMockAction('priority', {
      isAvailable: () => 'no digest',
    });
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([unavailable]);

    const result = await runPipeline(store, config);

    expect(unavailable.run).not.toHaveBeenCalled();
    expect(result.phase2Actions).toEqual([]);
  });

  it('continues after action errors', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    const config = makeConfig(tmpDir);

    const failing = createMockAction('duplicates', {
      run: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    });
    const working = createMockAction('priority');
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([failing, working]);

    const result = await runPipeline(store, config);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].actionId).toBe('duplicates');
    expect(working.run).toHaveBeenCalled();
    expect(result.phase2Actions).toEqual(['priority']);
  });

  it('reports closeFlaggedCount correctly', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    store.upsertIssue(makeIssueData(1));
    store.upsertIssue(makeIssueData(2));
    store.upsertIssue(makeIssueData(3));
    store.setDigest(1, digest);
    store.setDigest(2, digest);
    store.setDigest(3, digest);
    store.setAnalysis(1, { duplicateOf: 3 });
    store.setAnalysis(2, { doneDetected: true });

    const config = makeConfig(tmpDir);
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([]);

    const result = await runPipeline(store, config);

    expect(result.closeFlaggedCount).toBe(2);
  });

  it('forwards recheck and dryRun options', async () => {
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });
    const config = makeConfig(tmpDir);

    const duplicates = createMockAction('duplicates');
    const priority = createMockAction('priority');
    vi.spyOn(actionRegistry, 'getAll').mockReturnValue([duplicates, priority]);

    await runPipeline(store, config, { recheck: true, dryRun: true });

    expect(duplicates.run).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          recheck: true,
          dryRun: true,
        }),
      }),
    );
    expect(priority.run).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          recheck: true,
          dryRun: true,
        }),
      }),
    );
  });
});
