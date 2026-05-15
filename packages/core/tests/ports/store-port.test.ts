import { describe, it, expect } from 'vitest';
import { IssueStore, type Store, type StorePort } from '@cezar/core';

class InMemoryStoreAdapter implements StorePort {
  public saved: Store[] = [];

  constructor(private data: Store) {}

  async load(): Promise<Store> {
    return JSON.parse(JSON.stringify(this.data));
  }

  async save(store: Store): Promise<void> {
    this.saved.push(JSON.parse(JSON.stringify(store)));
    this.data = store;
  }
}

function emptyStore(): Store {
  return {
    meta: {
      owner: 'acme',
      repo: 'widgets',
      lastSyncedAt: null,
      totalFetched: 0,
      version: 1,
      orgMembers: [],
      orgMembersFetchedAt: null,
    },
    issues: [],
  };
}

describe('IssueStore.fromPort', () => {
  it('hydrates from a custom StorePort and persists through it', async () => {
    const port = new InMemoryStoreAdapter(emptyStore());
    const store = await IssueStore.fromPort(port);

    store.updateMeta({ totalFetched: 5 });
    await store.save();

    expect(port.saved).toHaveLength(1);
    expect(port.saved[0].meta.totalFetched).toBe(5);
  });

  it('upsert + save round-trips through the port', async () => {
    const port = new InMemoryStoreAdapter(emptyStore());
    const store = await IssueStore.fromPort(port);

    store.upsertIssue({
      number: 1,
      title: 'first',
      body: '',
      state: 'open',
      labels: [],
      author: 'alice',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      htmlUrl: 'https://example.com/1',
      contentHash: 'hash1',
      commentCount: 0,
      reactions: 0,
    });
    await store.save();

    expect(port.saved[0].issues).toHaveLength(1);
    expect(port.saved[0].issues[0].number).toBe(1);
  });
});
