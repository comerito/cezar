import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConfirmationPort, PreflightSummary, RootCausePrompt } from '@cezar/core';
import type { Database } from '../supabase/types';

/**
 * In-memory deferred map for pending confirmations. When the orchestrator
 * reaches the root-cause approval gate, a deferred is stored here.
 * A Server Action resolves it when the user clicks Proceed/Skip in the
 * cockpit. This works on a single-server deployment (Dokploy).
 */
interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  promise: Promise<T>;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

export interface PendingConfirmation {
  flowId: string;
  prompt: RootCausePrompt;
  deferred: Deferred<'proceed' | 'skip'>;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

export function resolvePendingConfirmation(flowId: string, decision: 'proceed' | 'skip'): boolean {
  const pending = pendingConfirmations.get(flowId);
  if (!pending) return false;
  pending.deferred.resolve(decision);
  pendingConfirmations.delete(flowId);
  return true;
}

export function cancelPendingConfirmation(flowId: string): void {
  const pending = pendingConfirmations.get(flowId);
  if (pending) {
    pending.deferred.reject(new Error('Flow cancelled'));
    pendingConfirmations.delete(flowId);
  }
}

export function getPendingConfirmation(flowId: string): PendingConfirmation | undefined {
  return pendingConfirmations.get(flowId);
}

/**
 * ConfirmationPort for the GUI. Root-cause approval stores a deferred
 * in memory and writes the prompt to the flow record so the cockpit
 * can render an approval modal.
 */
export class WebConfirmAdapter implements ConfirmationPort {
  constructor(
    private readonly flowId: string,
    private readonly supabase: SupabaseClient<Database>,
  ) {}

  async confirmPreflight(_summary: PreflightSummary): Promise<boolean> {
    return true;
  }

  async confirmRootCause(prompt: RootCausePrompt): Promise<'proceed' | 'skip'> {
    const deferred = createDeferred<'proceed' | 'skip'>();

    pendingConfirmations.set(this.flowId, { flowId: this.flowId, prompt, deferred });

    await this.supabase
      .from('flows')
      .update({
        status: 'running' as const,
        outcome: {
          pendingConfirmation: {
            issueNumber: prompt.issueNumber,
            issueTitle: prompt.issueTitle,
            rootCause: prompt.rootCause,
            confidence: prompt.confidence,
            evidence: prompt.evidence,
          },
        },
      } as any)
      .eq('id', this.flowId);

    return deferred.promise;
  }

  async confirm(_message: string): Promise<boolean> {
    return true;
  }
}
