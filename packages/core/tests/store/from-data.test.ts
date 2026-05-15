import { describe, it, expect } from 'vitest';
import { IssueStore, type Store } from '@cezar/core';

const snapshot: Store = {
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

describe('IssueStore.fromData', () => {
  it('builds an in-memory store from a snapshot', () => {
    const store = IssueStore.fromData(snapshot);
    expect(store.getMeta().owner).toBe('acme');
    expect(store.getAllData().issues).toEqual([]);
  });

  it('routes save() to onSave when provided', async () => {
    let saved: Store | null = null;
    const store = IssueStore.fromData(snapshot, { onSave: async (d) => { saved = d; } });
    store.updateMeta({ totalFetched: 3 });
    await store.save();
    expect(saved).not.toBeNull();
    expect(saved!.meta.totalFetched).toBe(3);
  });

  it('save() is a no-op without onSave', async () => {
    const store = IssueStore.fromData(snapshot);
    await expect(store.save()).resolves.toBeUndefined();
  });
});
