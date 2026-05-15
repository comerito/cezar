'use client';

import { startAutofix } from './autofix-actions';
import { useState } from 'react';

export function AutofixButton({ issueNumber }: { issueNumber: number }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await startAutofix(issueNumber);
    } catch {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
    >
      {loading ? '...' : 'Fix'}
    </button>
  );
}
