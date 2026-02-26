import { Octokit } from '@octokit/rest';
import type { Config } from '../models/config.model.js';
import { contentHash } from '../utils/hash.js';

export interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  contentHash: string;
}

export class GitHubService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(config: Config) {
    if (!config.github.token) {
      throw new Error('Invalid GitHub token. Check GITHUB_TOKEN env var.');
    }
    this.octokit = new Octokit({ auth: config.github.token });
    this.owner = config.github.owner;
    this.repo = config.github.repo;
  }

  async fetchAllIssues(includeClosed = false): Promise<RawIssue[]> {
    const state = includeClosed ? 'all' : 'open';
    try {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state,
        per_page: 100,
        sort: 'created',
        direction: 'asc',
      });

      return issues
        .filter(i => !i.pull_request) // exclude PRs
        .map(i => this.mapIssue(i));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchIssuesSince(since: string, includeClosed = false): Promise<RawIssue[]> {
    const state = includeClosed ? 'all' : 'open';
    try {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.owner,
        repo: this.repo,
        state,
        since,
        per_page: 100,
        sort: 'updated',
        direction: 'asc',
      });

      return issues
        .filter(i => !i.pull_request)
        .map(i => this.mapIssue(i));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    try {
      // Ensure label exists
      try {
        await this.octokit.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
        });
      } catch {
        await this.octokit.rest.issues.createLabel({
          owner: this.owner,
          repo: this.repo,
          name: label,
          color: 'e4e669',
          description: 'Duplicate issue detected by issue-manager',
        });
      }

      await this.octokit.rest.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels: [label],
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  private mapIssue(i: Record<string, unknown>): RawIssue {
    const issue = i as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      labels: Array<{ name?: string } | string>;
      user: { login: string } | null;
      created_at: string;
      updated_at: string;
      html_url: string;
    };

    const title = issue.title;
    const body = issue.body ?? '';

    return {
      number: issue.number,
      title,
      body,
      state: issue.state === 'closed' ? 'closed' : 'open',
      labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
      author: issue.user?.login ?? 'unknown',
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      htmlUrl: issue.html_url,
      contentHash: contentHash(title, body),
    };
  }

  private handleError(error: unknown): void {
    if (error && typeof error === 'object' && 'status' in error) {
      const status = (error as { status: number }).status;
      if (status === 401) {
        throw new Error('Invalid GitHub token. Check GITHUB_TOKEN env var.');
      }
      if (status === 403) {
        throw new Error('GitHub API rate limit exceeded or access forbidden.');
      }
      if (status === 404) {
        throw new Error(`Repo '${this.owner}/${this.repo}' not found or inaccessible.`);
      }
    }
  }
}
