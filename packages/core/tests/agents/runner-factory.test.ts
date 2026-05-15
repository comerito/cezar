import { describe, expect, it } from 'vitest';
import { createAgentRunner, DEFAULT_AGENT_BACKEND } from '../../src/agents/runner-factory.js';
import { AnthropicApiRunner } from '../../src/agents/anthropic-api-runner.js';
import { ClaudeCodeCliRunner } from '../../src/agents/claude-cli-runner.js';
import { CodexCliRunner } from '../../src/agents/codex-cli-runner.js';

describe('createAgentRunner', () => {
  it('returns the AnthropicApiRunner by default', () => {
    const runner = createAgentRunner();
    expect(runner).toBeInstanceOf(AnthropicApiRunner);
    expect(runner.backend).toBe('anthropic-api');
    expect(DEFAULT_AGENT_BACKEND).toBe('anthropic-api');
  });

  it('returns the right class per backend', () => {
    expect(createAgentRunner('anthropic-api')).toBeInstanceOf(AnthropicApiRunner);
    expect(createAgentRunner('claude-cli')).toBeInstanceOf(ClaudeCodeCliRunner);
    expect(createAgentRunner('codex-cli')).toBeInstanceOf(CodexCliRunner);
  });

  it('exposes the backend tag on each runner', () => {
    expect(createAgentRunner('claude-cli').backend).toBe('claude-cli');
    expect(createAgentRunner('codex-cli').backend).toBe('codex-cli');
  });

  it('passes a custom spawnFn/bin through to the CLI runners', () => {
    // Smoke: just that it constructs without throwing when options are given.
    const spawnFn = (() => {
      throw new Error('not called');
    }) as never;
    expect(() => createAgentRunner('claude-cli', { spawnFn, bin: '/opt/claude' })).not.toThrow();
    expect(() => createAgentRunner('codex-cli', { spawnFn, bin: '/opt/codex' })).not.toThrow();
  });

  it('throws on an unknown backend', () => {
    expect(() => createAgentRunner('weird-cli' as never)).toThrow(/Unknown agent backend/);
  });
});
