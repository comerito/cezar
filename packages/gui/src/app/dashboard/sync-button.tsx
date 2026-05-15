'use client';

import { useState, useEffect, useRef } from 'react';
import { startSync } from './sync-action';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

interface SyncProgress {
  stage: string;
  message: string;
  current?: number;
  total?: number;
}

export function SyncButton() {
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [logs, setLogs] = useState<SyncProgress[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<ReturnType<ReturnType<typeof createSupabaseBrowserClient>['channel']> | null>(null);

  useEffect(() => {
    return () => {
      if (channelRef.current) {
        createSupabaseBrowserClient().removeChannel(channelRef.current);
      }
    };
  }, []);

  async function handleSync() {
    setError(null);
    setLogs([]);
    setProgress(null);
    setSyncing(true);

    const result = await startSync();
    if (!result.ok || !result.syncId) {
      setError(result.error ?? 'Sync failed');
      setSyncing(false);
      return;
    }

    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(result.syncId);
    channelRef.current = channel;

    channel.on('broadcast', { event: 'progress' }, (msg) => {
      const p = msg.payload as SyncProgress;
      setProgress(p);
      setLogs((prev) => [...prev, p]);

      if (p.stage === 'done' || p.stage === 'error') {
        setSyncing(false);
        if (p.stage === 'error') setError(p.message);
        setTimeout(() => {
          supabase.removeChannel(channel);
          channelRef.current = null;
        }, 1000);
        setTimeout(() => window.location.reload(), 1500);
      }
    });

    channel.subscribe();
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-3">
        <button
          onClick={handleSync}
          disabled={syncing}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg hover:bg-accent-hover disabled:opacity-70"
        >
          {syncing ? 'Syncing...' : 'Sync & Digest'}
        </button>

        {syncing && progress && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-subtle">
              {progress.total && progress.current != null ? (
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              ) : (
                <div className="h-full w-full animate-pulse rounded-full bg-accent/40" />
              )}
            </div>
            <span className="max-w-xs truncate text-xs text-fg-muted">{progress.message}</span>
            <button
              onClick={() => setShowLogs((v) => !v)}
              className="text-xs text-fg-subtle underline hover:text-fg"
            >
              {showLogs ? 'hide' : 'logs'}
            </button>
          </div>
        )}

        {!syncing && error && (
          <span className="max-w-xs truncate text-xs text-danger" title={error}>{error}</span>
        )}

        {!syncing && !error && progress?.stage === 'done' && (
          <span className="text-xs text-accent">{progress.message}</span>
        )}
      </div>

      {showLogs && logs.length > 0 && (
        <div className="absolute right-0 top-full z-50 mt-2 max-h-64 w-[480px] overflow-y-auto rounded-lg border border-border bg-bg-elevated p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-fg-subtle">Sync Logs</span>
            <button onClick={() => setShowLogs(false)} className="text-xs text-fg-subtle hover:text-fg">close</button>
          </div>
          <div className="space-y-0.5">
            {logs.map((log, i) => (
              <div key={i} className={`text-[11px] ${log.stage === 'error' ? 'text-danger' : log.stage === 'done' ? 'text-accent' : 'text-fg-muted'}`}>
                <span className="mr-2 font-mono text-fg-subtle">[{log.stage}]</span>
                {log.message}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
