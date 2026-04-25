'use client';

import { useState } from 'react';
import { activateNotifiedCandidate } from '@/app/flows/actions';

export function ActivateButton({ issueNumber }: { issueNumber: number }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await activateNotifiedCandidate(issueNumber);
    } catch {
      // Server action will throw on contention ('not in notified state'); the
      // navigation away on success means we only reach this on failure.
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
    >
      {loading ? '...' : 'Activate fix'}
    </button>
  );
}
