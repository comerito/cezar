import type { SupabaseClient } from '@supabase/supabase-js';
import type { EventPort, AgentEvent } from '@cezar/core';
import type { Database } from '../supabase/types';

/**
 * Persists orchestrator events to the flow_events table. The cockpit
 * subscribes to Supabase Realtime on this table (RLS-scoped to the
 * flow's actor or admin).
 */
export class EventBridge implements EventPort {
  constructor(
    private readonly flowId: string,
    private readonly supabase: SupabaseClient<Database>,
  ) {}

  lifecycle(message: string): void {
    this.persist('lifecycle', { message });
  }

  agent(event: AgentEvent): void {
    this.persist('agent', event);
  }

  progress(phase: number, current: number, total: number): void {
    this.persist('lifecycle', { message: `Phase ${phase}: ${current}/${total}` });
  }

  private persist(type: 'lifecycle' | 'agent', payload: unknown): void {
    this.supabase
      .from('flow_events')
      .insert({
        flow_id: this.flowId,
        type,
        payload: payload as Database['public']['Tables']['flow_events']['Row']['payload'],
      })
      .then(({ error }) => {
        if (error) console.error('[EventBridge] persist failed:', error.message);
      });
  }
}
