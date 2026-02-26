import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreSchema, StoredIssueSchema, IssueAnalysisSchema, type Store, type StoredIssue, type IssueAnalysis, type IssueDigest, type StoreMeta } from './store.model.js';

export interface IssueFilter {
  state?: 'open' | 'closed' | 'all';
  hasDigest?: boolean;
}

export class IssueStore {
  private data: Store;
  private filePath: string;

  private constructor(data: Store, filePath: string) {
    this.data = data;
    this.filePath = filePath;
  }

  static async init(storePath: string, meta: { owner: string; repo: string }): Promise<IssueStore> {
    const filePath = join(storePath, 'store.json');
    const data: Store = {
      meta: {
        owner: meta.owner,
        repo: meta.repo,
        lastSyncedAt: null,
        totalFetched: 0,
        version: 1,
      },
      issues: [],
    };
    const store = new IssueStore(data, filePath);
    await store.save();
    return store;
  }

  static async load(storePath: string): Promise<IssueStore> {
    const filePath = join(storePath, 'store.json');
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    const data = StoreSchema.parse(parsed);
    return new IssueStore(data, filePath);
  }

  static async loadOrNull(storePath: string): Promise<IssueStore | null> {
    try {
      return await IssueStore.load(storePath);
    } catch {
      return null;
    }
  }

  async save(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    await writeFile(tmpPath, json, 'utf-8');
    try {
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  upsertIssue(issue: Omit<StoredIssue, 'digest' | 'analysis'>): { action: 'created' | 'updated' | 'unchanged' } {
    const existing = this.data.issues.find(i => i.number === issue.number);
    if (!existing) {
      const full = StoredIssueSchema.parse({ ...issue, digest: null, analysis: {} });
      this.data.issues.push(full);
      return { action: 'created' };
    }

    if (existing.contentHash !== issue.contentHash) {
      existing.title = issue.title;
      existing.body = issue.body;
      existing.state = issue.state;
      existing.labels = issue.labels;
      existing.author = issue.author;
      existing.updatedAt = issue.updatedAt;
      existing.htmlUrl = issue.htmlUrl;
      existing.contentHash = issue.contentHash;
      existing.commentCount = issue.commentCount;
      existing.reactions = issue.reactions;
      // Clear digest when content changes — needs re-digesting
      existing.digest = null;
      return { action: 'updated' };
    }

    // Update mutable fields that don't affect content hash
    existing.state = issue.state;
    existing.labels = issue.labels;
    existing.commentCount = issue.commentCount;
    existing.reactions = issue.reactions;
    return { action: 'unchanged' };
  }

  setDigest(issueNumber: number, digest: IssueDigest): void {
    const issue = this.data.issues.find(i => i.number === issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in store`);
    issue.digest = digest;
  }

  setAnalysis(issueNumber: number, analysis: Partial<IssueAnalysis>): void {
    const issue = this.data.issues.find(i => i.number === issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found in store`);
    issue.analysis = { ...issue.analysis, ...analysis };
  }

  getIssues(filter: IssueFilter = {}): StoredIssue[] {
    let result = this.data.issues;

    if (filter.state && filter.state !== 'all') {
      result = result.filter(i => i.state === filter.state);
    }

    if (filter.hasDigest === true) {
      result = result.filter(i => i.digest !== null);
    } else if (filter.hasDigest === false) {
      result = result.filter(i => i.digest === null);
    }

    return result;
  }

  getIssue(number: number): StoredIssue | undefined {
    return this.data.issues.find(i => i.number === number);
  }

  getMeta(): StoreMeta {
    return this.data.meta;
  }

  updateMeta(updates: Partial<StoreMeta>): void {
    Object.assign(this.data.meta, updates);
  }

  getAllData(): Store {
    return this.data;
  }
}
