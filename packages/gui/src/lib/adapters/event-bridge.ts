import type { SupabaseClient } from '@supabase/supabase-js';
import type { EventPort, AgentEvent } from '@cezar/core';
import type { Database } from '../supabase/types';

/**
 * Persists orchestrator events to the flow_events table AND broadcasts
 * them over a Supabase Realtime channel for instant client updates.
 *
 * Why both: postgres_changes subscriptions fail when the admin client
 * writes (bypasses RLS) but the browser client subscribes (RLS blocks
 * the notification). Broadcast channels skip RLS entirely.
 */
export class EventBridge implements EventPort {
  private channel: ReturnType<SupabaseClient['channel']>;
  private channelReady: Promise<void>;

  constructor(
    private readonly flowId: string,
    private readonly supabase: SupabaseClient<Database>,
  ) {
    this.channel = supabase.channel(`flow-live-${flowId}`);
    this.channelReady = new Promise((resolve) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') resolve();
      });
    });
  }

  lifecycle(message: string): void {
    this.emit('lifecycle', { message });
  }

  agent(event: AgentEvent): void {
    this.emit('agent', event);
  }

  progress(phase: number, current: number, total: number): void {
    this.emit('lifecycle', { message: `Phase ${phase}: ${current}/${total}` });
  }

  async dispose(): Promise<void> {
    await this.supabase.removeChannel(this.channel);
  }

  private emit(type: 'lifecycle' | 'agent', payload: unknown): void {
    const eventData = {
      id: crypto.randomUUID(),
      flow_id: this.flowId,
      type,
      payload,
      created_at: new Date().toISOString(),
    };

    // Persist to DB for history
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

    // Broadcast for instant client delivery
    this.channelReady.then(() => {
      this.channel.send({
        type: 'broadcast',
        event: 'flow_event',
        payload: eventData,
      });
    });
  }
}
