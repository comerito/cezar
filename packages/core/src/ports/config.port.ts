import type { Config } from '../config/config.model.js';

/**
 * Abstraction over config discovery. The CLI uses cosmiconfig to read
 * `.issuemanagerrc.json` from the cwd; the GUI loads from a workspaces row.
 */
export interface ConfigPort {
  load(): Promise<Config>;
  save?(config: Config): Promise<void>;
}
