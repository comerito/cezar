'use client';

import { useActionState, useState } from 'react';
import { timeAgo } from '@/lib/time-ago';
import { registerRunner, revokeRunner, type RunnerActionState } from './runners-actions';

export type RunnerDisplayStatus = 'online' | 'stale' | 'offline';

export interface RunnerRowView {
  id: string;
  name: string;
  kind: 'cloud' | 'self-hosted';
  backends: string[];
  displayStatus: RunnerDisplayStatus;
  lastHeartbeatAt: string | null;
  createdAt: string;
  managed: boolean;
}

interface RunnersSectionProps {
  ownRunners: RunnerRowView[];
  managedRunners: RunnerRowView[];
  isAdmin: boolean;
  appUrl: string;
}

// Backends a self-hosted runner can serve. `anthropic-api` is the managed-cloud
// one — a self-hosted runner *may* register for it (it just needs an API key in
// its env) but it's the unusual case, so it's offered as secondary.
const BACKEND_OPTIONS: { value: string; label: string; secondary?: boolean }[] = [
  { value: 'claude-cli', label: 'claude-cli (Claude Code subscription)' },
  { value: 'codex-cli', label: 'codex-cli (OpenAI Codex subscription)' },
  { value: 'anthropic-api', label: 'anthropic-api (uses ANTHROPIC_API_KEY — usually the managed cloud)', secondary: true },
];

const STATUS_STYLES: Record<RunnerDisplayStatus, string> = {
  online: 'bg-accent/15 text-accent',
  stale: 'bg-amber-500/15 text-amber-400',
  offline: 'bg-fg-subtle/15 text-fg-subtle',
};

export function RunnersSection({ ownRunners, managedRunners, isAdmin, appUrl }: RunnersSectionProps) {
  const [state, formAction, pending] = useActionState<RunnerActionState, FormData>(registerRunner, {});

  return (
    <div className="max-w-3xl space-y-10">
      {/* This workspace's runners */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">This workspace</h2>
        {ownRunners.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-6 text-center text-sm text-fg-muted">
            No self-hosted runners yet. {isAdmin ? 'Register one below.' : 'Ask an admin to register one.'}
          </div>
        ) : (
          <ul className="space-y-2">
            {ownRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={isAdmin} />
            ))}
          </ul>
        )}
      </section>

      {/* Managed / global runners (read-only) */}
      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">Managed — Cezar cloud</h2>
        {managedRunners.length === 0 ? (
          <div className="rounded-lg border border-border bg-bg-elevated p-4 text-sm text-fg-muted">
            <code className="text-fg">anthropic-api</code> jobs are handled by Cezar&apos;s own infrastructure (no
            self-hosted runner needed).
          </div>
        ) : (
          <ul className="space-y-2">
            {managedRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={false} />
            ))}
          </ul>
        )}
      </section>

      {/* Register a runner */}
      {isAdmin && (
        <section>
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">Register a runner</h2>

          {state.token && state.runnerId ? (
            <TokenReveal token={state.token} backends={state.backends ?? []} appUrl={appUrl} />
          ) : (
            <form action={formAction} className="rounded-lg border border-border bg-bg-elevated p-4 space-y-4">
              {state.error && (
                <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</div>
              )}
              <div>
                <label htmlFor="runner-name" className="mb-1 block text-xs text-fg-muted">Name</label>
                <input
                  id="runner-name"
                  name="name"
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. ci-box-1"
                  className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs text-fg-muted">Backends</span>
                <div className="space-y-1.5">
                  {BACKEND_OPTIONS.map((b) => (
                    <label key={b.value} className={`flex items-center gap-2 text-sm ${b.secondary ? 'text-fg-subtle' : 'text-fg'}`}>
                      <input type="checkbox" name="backends" value={b.value} defaultChecked={!b.secondary && b.value === 'claude-cli'} />
                      {b.label}
                    </label>
                  ))}
                </div>
              </div>
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? 'Registering…' : 'Register runner'}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}

function RunnerRow({ runner, canRevoke }: { runner: RunnerRowView; canRevoke: boolean }) {
  return (
    <li className="flex items-center gap-4 rounded-lg border border-border bg-bg-elevated px-4 py-3">
      <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[runner.displayStatus]}`}>
        {runner.displayStatus}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-fg">{runner.name}</span>
          {runner.managed && <span className="text-xs text-fg-subtle">Managed — Cezar cloud (anthropic-api)</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {(runner.managed ? ['anthropic-api'] : runner.backends).map((b) => (
            <span key={b} className="rounded bg-bg px-1.5 py-0.5 font-mono text-xs text-fg-muted">{b}</span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-right text-xs text-fg-subtle">
        <div>heartbeat {timeAgo(runner.lastHeartbeatAt)}</div>
        <div>added {timeAgo(runner.createdAt)}</div>
      </div>
      {canRevoke && !runner.managed && <RevokeButton runnerId={runner.id} name={runner.name} />}
    </li>
  );
}

function RevokeButton({ runnerId, name }: { runnerId: string; name: string }) {
  const [state, action, pending] = useActionState<RunnerActionState, FormData>(revokeRunner, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Revoke runner "${name}"? Its token stops working immediately.`)) e.preventDefault();
      }}
      className="shrink-0"
    >
      <input type="hidden" name="runnerId" value={runnerId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-border px-2.5 py-1 text-xs text-danger hover:border-danger disabled:opacity-50"
        title={state.error ?? undefined}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
    </form>
  );
}

function TokenReveal({ token, backends, appUrl }: { token: string; backends: string[]; appUrl: string }) {
  const url = appUrl || '<your-cezar-url>';
  const csv = (backends.length > 0 ? backends : ['claude-cli']).join(',');
  const command = `cezar-runner start --url ${url} --token ${token} --backends ${csv}`;
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/10 p-4 space-y-3">
      <p className="text-sm text-fg">
        Runner registered. <strong>Copy this token now — it won&apos;t be shown again.</strong>
      </p>
      <CopyBox label="Token" value={token} />
      <CopyBox label="Start command" value={command} />
      <p className="text-xs text-fg-subtle">
        Reload this page after copying. The token is never stored in plaintext — only a hash is kept.
      </p>
    </div>
  );
}

function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-fg-muted">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="text-xs text-accent hover:underline"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-fg">{value}</pre>
    </div>
  );
}
