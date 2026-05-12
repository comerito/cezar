import type { Config } from '../config/config.model.js';
import type { AgentBackend, AgentRunner } from './agent-runner.js';
import { AnthropicApiRunner } from './anthropic-api-runner.js';
import { ClaudeCodeCliRunner, type SpawnFn } from './claude-cli-runner.js';
import { CodexCliRunner } from './codex-cli-runner.js';

export interface CreateAgentRunnerOptions {
  /** Reserved for backend selection driven by workspace/repo config (Phase 1+). */
  config?: Config;
  /** Injectable subprocess spawner for the CLI backends (tests). */
  spawnFn?: SpawnFn;
  /** Override the CLI binary name/path (defaults: `claude` / `codex`). */
  bin?: string;
}

export const DEFAULT_AGENT_BACKEND: AgentBackend = 'anthropic-api';

/**
 * Pick the `AgentRunner` implementation for a backend. Cloud workers default to
 * `anthropic-api`; self-hosted runners advertise which CLI backends they serve.
 */
export function createAgentRunner(
  backend: AgentBackend = DEFAULT_AGENT_BACKEND,
  opts: CreateAgentRunnerOptions = {},
): AgentRunner {
  switch (backend) {
    case 'anthropic-api':
      return new AnthropicApiRunner();
    case 'claude-cli':
      return new ClaudeCodeCliRunner({ spawnFn: opts.spawnFn, bin: opts.bin });
    case 'codex-cli':
      return new CodexCliRunner({ spawnFn: opts.spawnFn, bin: opts.bin });
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unknown agent backend: ${String(exhaustive)}`);
    }
  }
}
