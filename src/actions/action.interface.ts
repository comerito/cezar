import type { IssueStore } from '../store/store.js';
import type { Config } from '../models/config.model.js';

export type ActionGroup = 'triage' | 'intelligence' | 'release' | 'community';

export interface ActionDefinition {
  /** Unique machine identifier. Used as CLI argument: `cezar run duplicates` */
  id: string;

  /** Display name shown in the interactive menu */
  label: string;

  /** One-line description for --help output */
  description: string;

  /** Emoji icon shown in menu */
  icon: string;

  /** Menu section grouping — actions with the same group are shown together */
  group: ActionGroup;

  /**
   * Returns a short badge string shown next to the action in the menu.
   * e.g. "45 unanalyzed", "last run 3h ago", ""
   */
  getBadge(store: IssueStore): string;

  /**
   * Returns true if the action can run, or a short reason string if it cannot.
   * e.g. "no issues with digest" or "run init first"
   */
  isAvailable(store: IssueStore): true | string;

  /**
   * Run the action.
   * @param ctx.interactive  true = show prompts/confirmations, false = use defaults + flags
   * @param ctx.options      parsed CLI flags
   */
  run(ctx: ActionContext): Promise<void>;
}

export interface ActionContext {
  store: IssueStore;
  config: Config;
  interactive: boolean;
  options: Record<string, unknown>;
}
