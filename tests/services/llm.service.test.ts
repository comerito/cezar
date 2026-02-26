import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMService } from '../../src/services/llm.service.js';
import type { Config } from '../../src/models/config.model.js';
import type { StoredIssue } from '../../src/store/store.model.js';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: mockCreate,
      },
    })),
  };
});

function makeConfig(): Config {
  return {
    github: { owner: 'test', repo: 'repo', token: 'ghp_test' },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: 'sk-ant-test123' },
    store: { path: '.issue-store' },
    sync: { digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false },
  };
}

function makeStoredIssue(number: number, digest = true): StoredIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    labels: [],
    author: 'user1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    htmlUrl: `https://github.com/test/repo/issues/${number}`,
    contentHash: 'abc123',
    digest: digest ? {
      summary: `Summary for issue ${number}`,
      category: 'bug',
      affectedArea: 'core',
      keywords: ['test'],
      digestedAt: '2024-01-01T00:00:00Z',
    } : null,
    analysis: {
      duplicateOf: null,
      duplicateConfidence: null,
      duplicateReason: null,
      duplicatesAnalyzedAt: null,
      priority: null,
      priorityReason: null,
      priorityAnalyzedAt: null,
    },
  };
}

describe('LLMService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws on missing API key', () => {
    const config = makeConfig();
    config.llm.apiKey = '';
    expect(() => new LLMService(config)).toThrow('Missing Anthropic API key');
  });

  describe('generateDigests', () => {
    it('parses valid digest response', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            digests: [{
              number: 1,
              summary: 'Login page crashes',
              category: 'bug',
              affectedArea: 'auth',
              keywords: ['login', 'crash'],
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );

      expect(result.size).toBe(1);
      const digest = result.get(1)!;
      expect(digest.summary).toBe('Login page crashes');
      expect(digest.category).toBe('bug');
      expect(digest.digestedAt).toBeTruthy();
    });

    it('handles markdown-wrapped JSON', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: '```json\n{"digests":[{"number":1,"summary":"test","category":"bug","affectedArea":"core","keywords":["a"]}]}\n```',
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );
      expect(result.size).toBe(1);
    });

    it('returns empty map on invalid JSON', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'not valid json at all' }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.generateDigests(
        [{ number: 1, title: 'Issue 1', body: 'Body 1' }],
        20,
      );
      expect(result.size).toBe(0);
    });

    it('batches issues correctly', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            digests: [{
              number: 1,
              summary: 'test',
              category: 'bug',
              affectedArea: 'core',
              keywords: ['a'],
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const issues = Array.from({ length: 5 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        body: `Body ${i + 1}`,
      }));

      await service.generateDigests(issues, 2);
      // 5 issues / batch size 2 = 3 batches
      expect(mockCreate).toHaveBeenCalledTimes(3);
    });
  });

  describe('detectDuplicates', () => {
    it('parses valid duplicate response', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            duplicates: [{
              number: 5,
              duplicateOf: 2,
              confidence: 0.95,
              reason: 'Both describe the same login bug',
            }],
          }),
        }],
      });

      const service = new LLMService(makeConfig());
      const candidates = [makeStoredIssue(5)];
      const kb = [makeStoredIssue(1), makeStoredIssue(2), makeStoredIssue(3)];

      const result = await service.detectDuplicates(candidates, kb);
      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(5);
      expect(result[0].duplicateOf).toBe(2);
      expect(result[0].confidence).toBe(0.95);
    });

    it('returns empty array when no duplicates found', async () => {
      mockCreate.mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({ duplicates: [] }),
        }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.detectDuplicates(
        [makeStoredIssue(5)],
        [makeStoredIssue(1)],
      );
      expect(result).toEqual([]);
    });

    it('returns empty on parse failure', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'I cannot determine duplicates' }],
      });

      const service = new LLMService(makeConfig());
      const result = await service.detectDuplicates(
        [makeStoredIssue(5)],
        [makeStoredIssue(1)],
      );
      expect(result).toEqual([]);
    });
  });
});
