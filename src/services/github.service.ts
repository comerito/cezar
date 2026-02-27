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
  commentCount: number;
  reactions: number;
  assignees: string[];
}

export interface TimelineCrossReference {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  merged: boolean;
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

  async fetchIssuesSince(since: string, _includeClosed = false): Promise<RawIssue[]> {
    // Always fetch all states for incremental sync — we need to detect
    // issues that were closed since the last sync to update local state.
    const state = 'all' as const;
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
          description: 'Managed by cezar',
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

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error) {
      // Ignore 404 — label wasn't on the issue
      if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 404) {
        return;
      }
      this.handleError(error);
      throw error;
    }
  }

  async setLabels(issueNumber: number, labels: string[]): Promise<void> {
    try {
      await this.octokit.rest.issues.setLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async closeIssue(issueNumber: number, reason: 'completed' | 'not_planned' = 'completed'): Promise<void> {
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        state: 'closed',
        state_reason: reason,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchRepoLabels(): Promise<string[]> {
    try {
      const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
        owner: this.owner,
        repo: this.repo,
        per_page: 100,
      });
      return labels.map(l => l.name);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async addAssignees(issueNumber: number, assignees: string[]): Promise<void> {
    try {
      await this.octokit.rest.issues.addAssignees({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        assignees,
      });
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async fetchCommentsForIssues(
    issueNumbers: number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<number, Array<{ author: string; body: string; createdAt: string }>>> {
    const result = new Map<number, Array<{ author: string; body: string; createdAt: string }>>();
    for (const [idx, num] of issueNumbers.entries()) {
      try {
        const comments = await this.getIssueComments(num);
        result.set(num, comments);
      } catch {
        // Skip issues where comment fetch fails
      }
      onProgress?.(idx + 1, issueNumbers.length);
    }
    return result;
  }

  async getIssueComments(issueNumber: number): Promise<Array<{ author: string; body: string; createdAt: string }>> {
    try {
      const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });
      return comments.map(c => ({
        author: c.user?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.created_at,
      }));
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  async getIssueTimeline(issueNumber: number): Promise<TimelineCrossReference[]> {
    try {
      const events = await this.octokit.paginate(this.octokit.rest.issues.listEventsForTimeline, {
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        per_page: 100,
      });

      const crossRefs: TimelineCrossReference[] = [];
      for (const event of events) {
        const e = event as Record<string, unknown>;
        if (e.event !== 'cross-referenced') continue;

        const source = e.source as Record<string, unknown> | undefined;
        if (!source) continue;

        const issue = source.issue as Record<string, unknown> | undefined;
        if (!issue) continue;

        const pr = issue.pull_request as Record<string, unknown> | undefined;
        if (!pr) continue; // not a PR reference

        const merged = pr.merged_at != null;
        if (!merged) continue; // only include merged PRs

        crossRefs.push({
          prNumber: issue.number as number,
          prTitle: issue.title as string,
          prUrl: issue.html_url as string,
          merged,
        });
      }

      return crossRefs;
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
      assignees?: Array<{ login: string }>;
      created_at: string;
      updated_at: string;
      html_url: string;
      comments: number;
      reactions?: { total_count: number };
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
      commentCount: issue.comments ?? 0,
      reactions: issue.reactions?.total_count ?? 0,
      assignees: issue.assignees?.map(a => a.login) ?? [],
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
