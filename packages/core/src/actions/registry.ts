import type { ActionDefinition } from './action.interface.js';

class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(action: ActionDefinition): void {
    this.actions.set(action.id, action);
  }

  get(id: string): ActionDefinition | undefined {
    return this.actions.get(id);
  }

  getAll(): ActionDefinition[] {
    return [...this.actions.values()];
  }
}

export const actionRegistry = new ActionRegistry();
