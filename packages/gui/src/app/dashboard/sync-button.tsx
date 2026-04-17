'use client';

import { useActionState } from 'react';
import { syncAndDigest, type SyncState } from './sync-action';

export function SyncButton() {
  const [state, formAction, pending] = useActionState<SyncState, FormData>(
    async (_prev) => syncAndDigest(_prev),
    {},
  );

  return (
    <div className="flex items-center gap-3">
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? 'Syncing...' : 'Sync & Digest'}
        </button>
      </form>
      {state.ok && (
        <span className="text-xs text-accent">
          {state.fetched} issues fetched, {state.digested} digested
        </span>
      )}
      {state.error && (
        <span className="max-w-xs truncate text-xs text-danger" title={state.error}>
          {state.error}
        </span>
      )}
    </div>
  );
}
