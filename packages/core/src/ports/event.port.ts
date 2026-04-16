/**
 * Granular agent activity emitted during long-running autofix sessions.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; tool: string; input: unknown }
  | { type: 'tool-result'; toolUseId: string; result: string; isError: boolean }
  | { type: 'budget-exceeded'; used: number; limit: number }
  | { type: 'turn-end'; tokensUsed: number };

/**
 * Abstraction over event reporting during action execution. The CLI routes
 * events to ora spinners and console lines; the GUI persists to a flow_events
 * table and pushes via Realtime.
 */
export interface EventPort {
  /** Orchestrator lifecycle event (e.g. "[#142] ANALYZE — locating root cause"). */
  lifecycle(message: string): void;

  /** Granular agent activity event during autofix sessions. */
  agent(event: AgentEvent): void;

  /** Pipeline-level progress (phase index, current/total within phase). */
  progress?(phase: number, current: number, total: number): void;
}
