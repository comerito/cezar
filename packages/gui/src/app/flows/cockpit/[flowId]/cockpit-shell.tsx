'use client';

import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { confirmFlowRootCause, cancelFlow } from '@/app/flows/actions';
import type { Database, FlowStatus, Json } from '@/lib/supabase/types';
import { cn } from '@/components/ui/cn';

type FlowRow = Database['public']['Tables']['flows']['Row'];
type EventRow = Database['public']['Tables']['flow_events']['Row'];

interface CockpitShellProps {
  flow: FlowRow;
  initialEvents: EventRow[];
}

const STAGES = ['worktree', 'analyze', 'approval', 'fix', 'commit', 'review', 'push', 'pr'] as const;

function deriveStage(events: EventRow[]): string {
  const lifecycle = events
    .filter((e) => e.type === 'lifecycle')
    .map((e) => ((e.payload as any)?.message as string) ?? '');
  const last = lifecycle[lifecycle.length - 1]?.toLowerCase() ?? '';
  if (last.includes('done') || last.includes('pr')) return 'pr';
  if (last.includes('push')) return 'push';
  if (last.includes('review')) return 'review';
  if (last.includes('commit')) return 'commit';
  if (last.includes('fix')) return 'fix';
  if (last.includes('approval') || last.includes('root-cause')) return 'approval';
  if (last.includes('analy')) return 'analyze';
  if (last.includes('worktree') || last.includes('preparing')) return 'worktree';
  return 'worktree';
}

function deriveBudget(events: EventRow[]): { used: number; limit: number } {
  let used = 0;
  let limit = 250_000;
  for (const e of events) {
    if (e.type !== 'agent') continue;
    const p = e.payload as any;
    if (p?.type === 'turn-end' && typeof p.tokensUsed === 'number') used += p.tokensUsed;
    if (p?.type === 'budget-exceeded') {
      used = p.used;
      limit = p.limit;
    }
  }
  return { used, limit };
}

export function CockpitShell({ flow, initialEvents }: CockpitShellProps) {
  const [events, setEvents] = useState<EventRow[]>(initialEvents);
  const [flowStatus, setFlowStatus] = useState<FlowStatus>(flow.status);
  const [flowOutcome, setFlowOutcome] = useState<Json | null>(flow.outcome);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    const channel = supabase
      .channel(`flow-events-${flow.id}`)
      .on(
        'postgres_changes' as any,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'flow_events',
          filter: `flow_id=eq.${flow.id}`,
        },
        (payload: any) => {
          setEvents((prev) => [...prev, payload.new as EventRow]);
        },
      )
      .on(
        'postgres_changes' as any,
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'flows',
          filter: `id=eq.${flow.id}`,
        },
        (payload: any) => {
          const updated = payload.new as FlowRow;
          setFlowStatus(updated.status);
          setFlowOutcome(updated.outcome);
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [flow.id]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);

  const currentStage = deriveStage(events);
  const budget = deriveBudget(events);
  const isTerminal = ['succeeded', 'failed', 'skipped', 'pr-opened'].includes(flowStatus);
  const pendingConfirmation = !isTerminal && (flowOutcome as any)?.pendingConfirmation;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">
            Cockpit — Issue #{flow.issue_number}
          </h1>
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <StatusBadge status={flowStatus} />
            <span>mode: {flow.mode}</span>
          </div>
        </div>
        {!isTerminal && (
          <button
            onClick={() => cancelFlow(flow.id)}
            className="rounded-md border border-danger/40 px-3 py-1 text-xs text-danger hover:bg-danger/10"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Three-column layout */}
      <div className="grid flex-1 grid-cols-[220px_1fr_260px] overflow-hidden">
        {/* Left: Stage tracker */}
        <div className="border-r border-border bg-bg-elevated p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">Stages</div>
          <div className="flex flex-col gap-1">
            {STAGES.map((stage) => {
              const idx = STAGES.indexOf(stage);
              const currentIdx = STAGES.indexOf(currentStage as any);
              const done = idx < currentIdx || isTerminal;
              const active = idx === currentIdx && !isTerminal;
              return (
                <div
                  key={stage}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs',
                    done && 'text-accent',
                    active && 'bg-bg-subtle font-medium text-fg',
                    !done && !active && 'text-fg-subtle',
                  )}
                >
                  {done ? '✓' : active ? '▸' : '·'} {stage}
                </div>
              );
            })}
          </div>
        </div>

        {/* Center: Event feed */}
        <div ref={feedRef} className="overflow-y-auto p-4">
          {/* Approval modal */}
          {pendingConfirmation && (
            <ApprovalCard
              flowId={flow.id}
              confirmation={pendingConfirmation}
            />
          )}

          {events.length === 0 && (
            <div className="py-8 text-center text-sm text-fg-muted">Waiting for events...</div>
          )}
          {events.map((e) => (
            <EventLine key={e.id} event={e} />
          ))}

          {/* Terminal outcome */}
          {isTerminal && flowOutcome && <OutcomeCard outcome={flowOutcome} />}
        </div>

        {/* Right: Budget + info */}
        <div className="border-l border-border bg-bg-elevated p-4">
          <div className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">Budget</div>
          <BudgetBar used={budget.used} limit={budget.limit} />
          <div className="mt-2 text-xs text-fg-muted">
            {budget.used.toLocaleString()} / {budget.limit.toLocaleString()} tokens
          </div>

          <div className="mt-6 text-xs font-medium uppercase tracking-wider text-fg-subtle">Info</div>
          <div className="mt-2 space-y-1 text-xs text-fg-muted">
            <div>Flow: {flow.id.slice(0, 8)}...</div>
            <div>Issue: #{flow.issue_number}</div>
            <div>Mode: {flow.mode}</div>
            {(flowOutcome as any)?.branch && <div>Branch: {(flowOutcome as any).branch}</div>}
            {(flowOutcome as any)?.prUrl && (
              <a href={(flowOutcome as any).prUrl} target="_blank" rel="noreferrer" className="block text-accent hover:underline">
                View PR
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: FlowStatus }) {
  const colors: Record<string, string> = {
    pending: 'bg-fg-subtle/20 text-fg-subtle',
    running: 'bg-accent/20 text-accent',
    succeeded: 'bg-accent/20 text-accent',
    failed: 'bg-danger/20 text-danger',
    skipped: 'bg-fg-subtle/20 text-fg-subtle',
    'pr-opened': 'bg-accent/20 text-accent',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${colors[status] ?? ''}`}>
      {status}
    </span>
  );
}

function BudgetBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100);
  const danger = pct >= 80;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-bg-subtle">
      <div
        className={cn('h-full rounded-full transition-all', danger ? 'bg-danger' : 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function EventLine({ event }: { event: EventRow }) {
  const payload = event.payload as any;
  if (event.type === 'lifecycle') {
    return (
      <div className="border-l-2 border-accent/30 py-1 pl-3 text-xs text-fg-muted">
        {payload?.message ?? JSON.stringify(payload)}
      </div>
    );
  }

  const agentType = payload?.type as string | undefined;
  if (agentType === 'text') {
    return (
      <div className="py-0.5 pl-3 text-xs text-fg">
        {payload.text}
      </div>
    );
  }
  if (agentType === 'tool') {
    return (
      <div className="py-0.5 pl-3 text-xs text-fg-muted">
        <span className="font-mono text-accent">▸ {payload.tool}</span>
        {payload.input && typeof payload.input === 'object' && 'file_path' in (payload.input as any) && (
          <span className="ml-1 text-fg-subtle">{(payload.input as any).file_path}</span>
        )}
      </div>
    );
  }
  if (agentType === 'tool-result') {
    const preview = typeof payload.result === 'string' ? payload.result.slice(0, 120) : '';
    return (
      <div className={cn('py-0.5 pl-3 text-[11px]', payload.isError ? 'text-danger' : 'text-fg-subtle')}>
        ◂ {preview}{payload.result?.length > 120 ? '...' : ''}
      </div>
    );
  }
  if (agentType === 'turn-end') {
    return (
      <div className="py-0.5 pl-3 text-[10px] text-fg-subtle">
        — turn end ({payload.tokensUsed?.toLocaleString()} tokens)
      </div>
    );
  }
  if (agentType === 'budget-exceeded') {
    return (
      <div className="py-0.5 pl-3 text-xs text-danger">
        Budget exceeded: {payload.used?.toLocaleString()} / {payload.limit?.toLocaleString()}
      </div>
    );
  }
  return null;
}

function ApprovalCard({ flowId, confirmation }: { flowId: string; confirmation: any }) {
  return (
    <div className="mb-4 rounded-lg border border-accent/40 bg-bg-elevated p-4">
      <div className="mb-2 text-sm font-medium text-fg">Root-cause approval needed</div>
      <div className="mb-1 text-xs text-fg-muted">Issue #{confirmation.issueNumber}: {confirmation.issueTitle}</div>
      <div className="mb-2 text-xs text-fg">{confirmation.rootCause}</div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <span className="text-fg-muted">Confidence:</span>
        <span className={confirmation.confidence >= 0.7 ? 'text-accent' : confirmation.confidence >= 0.5 ? 'text-yellow-400' : 'text-danger'}>
          {Math.round(confirmation.confidence * 100)}%
        </span>
      </div>
      {confirmation.evidence?.length > 0 && (
        <div className="mb-3 text-xs text-fg-subtle">
          Suspected: {confirmation.evidence.join(', ')}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => confirmFlowRootCause(flowId, 'proceed')}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-bg hover:bg-accent-hover"
        >
          Proceed
        </button>
        <button
          onClick={() => confirmFlowRootCause(flowId, 'skip')}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-subtle"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

function OutcomeCard({ outcome }: { outcome: Json }) {
  const o = outcome as any;
  if (!o?.status) return null;
  const isSuccess = o.status === 'pr-opened' || o.status === 'dry-run' || o.status === 'succeeded';
  return (
    <div className={cn(
      'mt-4 rounded-lg border p-4',
      isSuccess ? 'border-accent/30 bg-accent/5' : 'border-danger/30 bg-danger/5',
    )}>
      <div className={cn('text-sm font-medium', isSuccess ? 'text-accent' : 'text-danger')}>
        {o.status === 'pr-opened' && `PR opened: ${o.prUrl}`}
        {o.status === 'dry-run' && 'Dry run passed — review approved'}
        {o.status === 'succeeded' && 'Succeeded'}
        {o.status === 'failed' && `Failed: ${o.reason}`}
        {o.status === 'skipped' && `Skipped: ${o.reason}`}
      </div>
      {o.rootCause && (
        <div className="mt-2 text-xs text-fg-muted">
          Root cause: {o.rootCause.summary ?? o.rootCause}
        </div>
      )}
    </div>
  );
}
