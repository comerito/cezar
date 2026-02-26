import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubService } from '../../src/services/github.service.js';
import type { Config } from '../../src/models/config.model.js';

// Mock Octokit
vi.mock('@octokit/rest', () => {
  const mockPaginate = vi.fn();
  const mockListForRepo = vi.fn();
  const mockGetLabel = vi.fn();
  const mockCreateLabel = vi.fn();
  const mockAddLabels = vi.fn();

  return {
    Octokit: vi.fn().mockImplementation(function () {
      return {
        paginate: mockPaginate,
        rest: {
          issues: {
            listForRepo: mockListForRepo,
            getLabel: mockGetLabel,
            createLabel: mockCreateLabel,
            addLabels: mockAddLabels,
          },
        },
      };
    }),
    __mockPaginate: mockPaginate,
    __mockGetLabel: mockGetLabel,
    __mockCreateLabel: mockCreateLabel,
    __mockAddLabels: mockAddLabels,
  };
});

function makeConfig(overrides: Partial<Config['github']> = {}): Config {
  return {
    github: { owner: 'test-owner', repo: 'test-repo', token: 'ghp_test123', ...overrides },
    llm: { model: 'claude-sonnet-4-20250514', maxTokens: 4096, apiKey: '' },
    store: { path: '.issue-store' },
    sync: { digestBatchSize: 20, duplicateBatchSize: 30, minDuplicateConfidence: 0.80, includeClosed: false },
  };
}

function makeGitHubIssue(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: 'open',
    labels: [{ name: 'bug' }],
    user: { login: 'author1' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    html_url: `https://github.com/test/repo/issues/${number}`,
    ...overrides,
  };
}

describe('GitHubService', () => {
  let mockPaginate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@octokit/rest') as unknown as {
      __mockPaginate: ReturnType<typeof vi.fn>;
    };
    mockPaginate = mod.__mockPaginate;
  });

  it('throws on missing token', () => {
    expect(() => new GitHubService(makeConfig({ token: '' }))).toThrow('Invalid GitHub token');
  });

  describe('fetchAllIssues', () => {
    it('fetches and maps issues correctly', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(1),
        makeGitHubIssue(2, { state: 'closed' }),
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();

      expect(issues).toHaveLength(2);
      expect(issues[0].number).toBe(1);
      expect(issues[0].title).toBe('Issue 1');
      expect(issues[0].state).toBe('open');
      expect(issues[0].labels).toEqual(['bug']);
      expect(issues[0].author).toBe('author1');
      expect(issues[0].contentHash).toBeTruthy();
      expect(issues[1].state).toBe('closed');
    });

    it('excludes pull requests', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(1),
        { ...makeGitHubIssue(2), pull_request: { url: 'https://...' } },
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(1);
    });

    it('handles null body', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(1, { body: null }),
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchAllIssues();
      expect(issues[0].body).toBe('');
    });
  });

  describe('fetchIssuesSince', () => {
    it('passes since parameter and filters PRs', async () => {
      mockPaginate.mockResolvedValue([
        makeGitHubIssue(3),
      ]);

      const service = new GitHubService(makeConfig());
      const issues = await service.fetchIssuesSince('2024-01-01T00:00:00Z');

      expect(issues).toHaveLength(1);
      expect(mockPaginate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ since: '2024-01-01T00:00:00Z' }),
      );
    });
  });

  describe('error handling', () => {
    it('throws descriptive error on 401', async () => {
      mockPaginate.mockRejectedValue({ status: 401 });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow('Invalid GitHub token');
    });

    it('throws descriptive error on 404', async () => {
      mockPaginate.mockRejectedValue({ status: 404 });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow('not found or inaccessible');
    });

    it('throws descriptive error on 403', async () => {
      mockPaginate.mockRejectedValue({ status: 403 });

      const service = new GitHubService(makeConfig());
      await expect(service.fetchAllIssues()).rejects.toThrow('rate limit exceeded');
    });
  });
});
