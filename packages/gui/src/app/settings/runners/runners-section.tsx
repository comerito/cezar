'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { StatusDotIcon } from '@/components/icons';
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
// one — a self-hosted runner *may* register for it (it just needs an API key
// in its env) but it's the unusual case, so it's offered as secondary.
const BACKEND_OPTIONS: { value: string; label: string; secondary?: boolean }[] = [
  { value: 'claude-cli',    label: 'claude-cli — Claude Code subscription' },
  { value: 'codex-cli',     label: 'codex-cli — OpenAI Codex subscription' },
  { value: 'anthropic-api', label: 'anthropic-api — uses ANTHROPIC_API_KEY (usually the managed cloud)', secondary: true },
];

const STATUS_TONE: Record<RunnerDisplayStatus, 'enabled' | 'warning' | 'queued'> = {
  online: 'enabled',
  stale: 'warning',
  offline: 'queued',
};

const STATUS_LABEL_CLASS: Record<RunnerDisplayStatus, string> = {
  online: 'text-emerald-300',
  stale: 'text-tertiary',
  offline: 'text-on-surface-variant',
};

export function RunnersSection({ ownRunners, managedRunners, isAdmin, appUrl }: RunnersSectionProps) {
  const [state, formAction, pending] = useActionState<RunnerActionState, FormData>(registerRunner, {});

  return (
    <div className="space-y-6">
      {/* This workspace's runners */}
      <Card title="This workspace" subtitle={`${ownRunners.length} self-hosted runner${ownRunners.length === 1 ? '' : 's'}`}>
        {ownRunners.length === 0 ? (
          <EmptyState
            body={
              isAdmin
                ? 'No self-hosted runners yet. Register one below.'
                : 'No self-hosted runners yet. Ask an admin to register one.'
            }
          />
        ) : (
          <ul className="divide-y divide-outline-variant/60">
            {ownRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={isAdmin} />
            ))}
          </ul>
        )}
      </Card>

      {/* Managed / global runners (read-only) */}
      <Card title="Managed — Cezar cloud" subtitle="anthropic-api jobs are handled by Cezar's own infrastructure">
        {managedRunners.length === 0 ? (
          <EmptyState body="No managed runners configured. The dispatcher cron handles anthropic-api jobs directly — no self-hosted runner needed." />
        ) : (
          <ul className="divide-y divide-outline-variant/60">
            {managedRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={false} />
            ))}
          </ul>
        )}
      </Card>

      {/* Register a runner */}
      {isAdmin && (
        <Card title="Register a runner">
          {state.token && state.runnerId ? (
            <TokenReveal token={state.token} backends={state.backends ?? []} appUrl={appUrl} />
          ) : (
            <form action={formAction} className="space-y-4">
              {state.error && (
                <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
                  {state.error}
                </div>
              )}
              <div>
                <label htmlFor="runner-name" className="mb-1 block text-xs font-medium text-on-surface-variant">
                  Name
                </label>
                <input
                  id="runner-name"
                  name="name"
                  type="text"
                  required
                  maxLength={80}
                  placeholder="e.g. ci-box-1"
                  className="h-9 w-full max-w-md rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <span className="mb-1 block text-xs font-medium text-on-surface-variant">Backends</span>
                <div className="space-y-2">
                  {BACKEND_OPTIONS.map((b) => (
                    <label
                      key={b.value}
                      className={cn(
                        'flex items-center gap-3 rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm',
                        b.secondary && 'opacity-80',
                      )}
                    >
                      <input
                        type="checkbox"
                        name="backends"
                        value={b.value}
                        defaultChecked={!b.secondary && b.value === 'claude-cli'}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="text-on-surface">{b.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending ? 'Registering…' : 'Register runner'}
                </button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      <header className="border-b border-outline-variant/60 px-6 py-4">
        <h2 className="font-display text-[15px] font-semibold tracking-tight text-on-surface">{title}</h2>
        {subtitle && <p className="mt-1 text-xs text-on-surface-variant">{subtitle}</p>}
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

function EmptyState({ body }: { body: string }) {
  return (
    <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low/40 p-6 text-center text-sm text-on-surface-variant">
      {body}
    </div>
  );
}

function RunnerRow({ runner, canRevoke }: { runner: RunnerRowView; canRevoke: boolean }) {
  return (
    <li className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <StatusDotIcon className="h-3 w-3 shrink-0" tone={STATUS_TONE[runner.displayStatus]} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate font-medium text-on-surface">{runner.name}</span>
          <span
            className={cn(
              'font-display text-[10.5px] font-semibold uppercase tracking-wider',
              STATUS_LABEL_CLASS[runner.displayStatus],
            )}
          >
            {runner.displayStatus}
          </span>
          {runner.managed && (
            <span className="font-mono text-[11px] text-outline">managed</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {(runner.managed ? ['anthropic-api'] : runner.backends).map((b) => (
            <span
              key={b}
              className="rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 font-mono text-[10.5px] text-on-surface-variant"
            >
              {b}
            </span>
          ))}
        </div>
      </div>
      <div className="shrink-0 text-right text-[11px] text-outline">
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
        className="inline-flex h-7 items-center rounded-md border border-outline-variant bg-surface px-2.5 text-xs text-on-surface-variant transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/10 p-4">
      <p className="text-sm text-on-surface">
        Runner registered. <strong className="text-primary">Copy the token now — it won&apos;t be shown again.</strong>
      </p>
      <CopyBox label="Token" value={token} />
      <CopyBox label="Start command" value={command} />
      <p className="text-xs text-on-surface-variant">
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
        <span className="text-xs font-medium text-on-surface-variant">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="text-xs text-primary hover:underline"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface">
{value}
      </pre>
    </div>
  );
}
