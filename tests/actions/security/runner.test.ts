import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SecurityRunner, SecurityResults } from '../../../src/actions/security/runner.js';
import { IssueStore } from '../../../src/store/store.js';
import { contentHash } from '../../../src/utils/hash.js';
import type { Config } from '../../../src/models/config.model.js';
import type { LLMService } from '../../../src/services/llm.service.js';
import type { SecurityResponse } from '../../../src/actions/security/prompt.js';

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

function makeDigest(category: 'bug' | 'feature' | 'question' | 'docs' = 'bug') {
  return {
    summary: `A test ${category}`,
    category,
    affectedArea: 'core',
    keywords: ['test'],
    digestedAt: '2024-01-01T00:00:00Z',
  };
}

function createMockLLM(response: SecurityResponse): LLMService {
  return {
    analyze: vi.fn().mockResolvedValue(response),
    detectDuplicates: vi.fn(),
    generateDigests: vi.fn(),
  } as unknown as LLMService;
}

describe('SecurityRunner', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'security-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupStore(opts: {
    count?: number;
    withDigest?: boolean;
    analyzedCount?: number;
    categories?: Array<'bug' | 'feature' | 'question' | 'docs'>;
  } = {}): Promise<IssueStore> {
    const { count = 0, withDigest = true, analyzedCount = 0, categories } = opts;
    const store = await IssueStore.init(tmpDir, { owner: 'test', repo: 'repo' });

    for (let i = 1; i <= count; i++) {
      store.upsertIssue(makeIssueData(i));
      if (withDigest) {
        const cat = categories?.[i - 1] ?? 'bug';
        store.setDigest(i, makeDigest(cat));
      }
      if (i <= analyzedCount) {
        store.setAnalysis(i, { securityAnalyzedAt: '2024-01-01T00:00:00Z' });
      }
    }

    await store.save();
    return store;
  }

  it('detects security findings and persists to store', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      findings: [
        { number: 1, isSecurityRelated: true, confidence: 0.94, category: 'data exposure', severity: 'high', explanation: 'API key in error response' },
        { number: 2, isSecurityRelated: false, confidence: 0.2, category: '', severity: 'low', explanation: '' },
        { number: 3, isSecurityRelated: true, confidence: 0.88, category: 'auth bypass', severity: 'critical', explanation: 'Admin panel without login' },
      ],
    });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    const results = await runner.scan();

    expect(results.findings).toHaveLength(2);
    // Sorted by severity: critical first, then high
    expect(results.findings[0].number).toBe(3);
    expect(results.findings[0].category).toBe('auth bypass');
    expect(results.findings[0].severity).toBe('critical');
    expect(results.findings[1].number).toBe(1);
    expect(results.findings[1].severity).toBe('high');

    // Check store was updated for security finding
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.securityFlag).toBe(true);
    expect(issue1.analysis.securityConfidence).toBe(0.94);
    expect(issue1.analysis.securityCategory).toBe('data exposure');
    expect(issue1.analysis.securitySeverity).toBe('high');
    expect(issue1.analysis.securityAnalyzedAt).toBeTruthy();

    // Non-security should be marked analyzed with flag false
    const issue2 = store.getIssue(2)!;
    expect(issue2.analysis.securityFlag).toBe(false);
    expect(issue2.analysis.securityAnalyzedAt).toBeTruthy();
  });

  it('scans ALL categories, not just bugs', async () => {
    const store = await setupStore({
      count: 4,
      categories: ['bug', 'feature', 'question', 'docs'],
    });
    const mockLLM = createMockLLM({ findings: [] });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    await runner.scan();

    // LLM should receive all 4 issues regardless of category
    expect(mockLLM.analyze).toHaveBeenCalledTimes(1);
    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('#1');
    expect(prompt).toContain('#2');
    expect(prompt).toContain('#3');
    expect(prompt).toContain('#4');
  });

  it('filters out findings below 0.70 confidence', async () => {
    const store = await setupStore({ count: 2 });
    const mockLLM = createMockLLM({
      findings: [
        { number: 1, isSecurityRelated: true, confidence: 0.69, category: 'injection', severity: 'medium', explanation: 'Low confidence' },
        { number: 2, isSecurityRelated: true, confidence: 0.70, category: 'data exposure', severity: 'high', explanation: 'At threshold' },
      ],
    });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    const results = await runner.scan();

    // Only issue 2 meets the 0.70 threshold
    expect(results.findings).toHaveLength(1);
    expect(results.findings[0].number).toBe(2);

    // Issue 1 should be marked as not security-related
    const issue1 = store.getIssue(1)!;
    expect(issue1.analysis.securityFlag).toBe(false);
    expect(issue1.analysis.securityAnalyzedAt).toBeTruthy();
  });

  it('returns results sorted by severity (critical first)', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      findings: [
        { number: 1, isSecurityRelated: true, confidence: 0.8, category: 'xss', severity: 'low', explanation: 'Minor XSS' },
        { number: 2, isSecurityRelated: true, confidence: 0.9, category: 'auth bypass', severity: 'critical', explanation: 'Critical bypass' },
        { number: 3, isSecurityRelated: true, confidence: 0.85, category: 'data exposure', severity: 'high', explanation: 'Data leak' },
      ],
    });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    const results = await runner.scan();

    expect(results.findings.map(f => f.severity)).toEqual(['critical', 'high', 'low']);
    expect(results.findings.map(f => f.number)).toEqual([2, 3, 1]);
  });

  it('skips already-analyzed issues unless --recheck', async () => {
    const store = await setupStore({ count: 3, analyzedCount: 3 });
    const mockLLM = createMockLLM({ findings: [] });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);

    // Without recheck — should return early
    const results = await runner.scan();
    expect(results.message).toContain('already scanned');
    expect(mockLLM.analyze).not.toHaveBeenCalled();

    // With recheck — should run
    await runner.scan({ recheck: true });
    expect(mockLLM.analyze).toHaveBeenCalled();
  });

  it('marks candidates not returned by LLM as analyzed', async () => {
    const store = await setupStore({ count: 3 });
    const mockLLM = createMockLLM({
      findings: [
        { number: 1, isSecurityRelated: false, confidence: 0.1, category: '', severity: 'low', explanation: '' },
      ],
    });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    await runner.scan();

    for (let i = 1; i <= 3; i++) {
      expect(store.getIssue(i)!.analysis.securityAnalyzedAt).toBeTruthy();
    }
  });

  it('batches candidates correctly', async () => {
    const config = makeConfig();
    config.sync.securityBatchSize = 2;

    const store = await setupStore({ count: 5 });
    const mockLLM = createMockLLM({ findings: [] });

    const runner = new SecurityRunner(store, config, mockLLM);
    await runner.scan();

    // 5 issues / batch size 2 = 3 batches
    expect(mockLLM.analyze).toHaveBeenCalledTimes(3);
  });

  it('does not save store when dryRun is true', async () => {
    const store = await setupStore({ count: 2 });
    const saveSpy = vi.spyOn(store, 'save');
    const mockLLM = createMockLLM({
      findings: [
        { number: 1, isSecurityRelated: true, confidence: 0.9, category: 'injection', severity: 'high', explanation: 'SQL injection' },
      ],
    });

    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    await runner.scan({ dryRun: true });

    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('empty result has correct properties', () => {
    const results = SecurityResults.empty('No work needed');
    expect(results.isEmpty).toBe(true);
    expect(results.message).toBe('No work needed');
  });

  it('uses full issue body in prompt (not just digest)', async () => {
    const store = await setupStore({ count: 0 });
    store.upsertIssue(makeIssueData(1, { body: 'API key leaked in /api/debug endpoint response body' }));
    store.setDigest(1, makeDigest('bug'));
    await store.save();

    const mockLLM = createMockLLM({ findings: [] });
    const runner = new SecurityRunner(store, makeConfig(), mockLLM);
    await runner.scan();

    const prompt = (mockLLM.analyze as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('API key leaked in /api/debug endpoint response body');
  });
});
