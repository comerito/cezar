import { loadConfig, type Config, type ConfigPort } from '@cezar/core';

/**
 * Default ConfigPort impl backed by cosmiconfig discovery (`.issuemanagerrc.*`
 * in the cwd), with GITHUB_TOKEN / ANTHROPIC_API_KEY env overrides merged in.
 */
export class CosmiconfigAdapter implements ConfigPort {
  constructor(private readonly overrides: Partial<Config> = {}) {}

  async load(): Promise<Config> {
    return loadConfig(this.overrides);
  }
}
