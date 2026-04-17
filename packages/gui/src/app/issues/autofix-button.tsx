'use client';

import { startAutofix } from '@/app/flows/actions';
import { useState } from 'react';

export function AutofixButton({ issueNumber }: { issueNumber: number }) {
  const [mode, setMode] = useState<'apply' | 'dry-run'>('dry-run');
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await startAutofix(issueNumber, mode);
    } catch {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handleClick}
        disabled={loading}
        className="rounded-md bg-accent px-2 py-0.5 text-[10px] font-medium text-bg hover:bg-accent-hover disabled:opacity-50"
      >
        {loading ? '...' : 'Fix'}
      </button>
      <select
        value={mode}
        onChange={(e) => setMode(e.target.value as 'apply' | 'dry-run')}
        className="rounded border border-border bg-bg px-1 py-0.5 text-[10px] text-fg-muted"
      >
        <option value="dry-run">dry-run</option>
        <option value="apply">apply</option>
      </select>
    </div>
  );
}
