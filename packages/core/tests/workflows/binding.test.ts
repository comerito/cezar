import { describe, expect, it } from 'vitest';
import { resolveStepConfig, type WorkflowBinding } from '../../src/workflows/binding.js';
import type { Skill } from '../../src/skills/skill-catalog.js';

const BUILTIN_PROMPT = 'You are the ANALYZER agent.\nDo the thing.';
const BUILTIN_MODEL = 'claude-sonnet-builtin';

const skills: Skill[] = [
  {
    name: 'deep-root-cause',
    description: 'repo guidance',
    body: 'Check the request-id middleware first.',
    path: '/repo/.ai/skills/root-cause.md',
    suggestedStages: ['root-cause'],
  },
];

describe('resolveStepConfig', () => {
  it('with no binding returns the builtin prompt verbatim + anthropic-api + builtin model', () => {
    const r = resolveStepConfig({
      stepId: 'root-cause',
      builtinSystemPrompt: BUILTIN_PROMPT,
      builtinModel: BUILTIN_MODEL,
      skills,
    });
    expect(r.systemPrompt).toBe(BUILTIN_PROMPT);
    expect(r.backend).toBe('anthropic-api');
    expect(r.model).toBe(BUILTIN_MODEL);
    expect(r.extraTools).toEqual([]);
    expect(r.skillName).toBeNull();
  });

  it('with a binding (skill + model + backend + extraTools) augments the prompt and applies overrides', () => {
    const binding: WorkflowBinding = {
      stepId: 'root-cause',
      skillName: 'deep-root-cause',
      backend: 'claude-cli',
      model: 'claude-opus-bound',
      extraTools: ['WebFetch'],
    };
    const r = resolveStepConfig({
      stepId: 'root-cause',
      builtinSystemPrompt: BUILTIN_PROMPT,
      builtinModel: BUILTIN_MODEL,
      binding,
      skills,
    });
    expect(r.systemPrompt.startsWith(BUILTIN_PROMPT)).toBe(true);
    expect(r.systemPrompt).toContain('## Repo-specific guidance');
    expect(r.systemPrompt).toContain('Check the request-id middleware first.');
    expect(r.backend).toBe('claude-cli');
    expect(r.model).toBe('claude-opus-bound');
    expect(r.extraTools).toEqual(['WebFetch']);
    expect(r.skillName).toBe('deep-root-cause');
  });

  it('with a binding pointing at a non-existent skill does not crash and does not augment', () => {
    const binding: WorkflowBinding = {
      stepId: 'fix',
      skillName: 'no-such-skill',
      backend: null,
      model: null,
      extraTools: [],
    };
    const r = resolveStepConfig({
      stepId: 'fix',
      builtinSystemPrompt: BUILTIN_PROMPT,
      builtinModel: BUILTIN_MODEL,
      binding,
      skills,
    });
    expect(r.systemPrompt).toBe(BUILTIN_PROMPT);
    expect(r.backend).toBe('anthropic-api');
    expect(r.model).toBe(BUILTIN_MODEL);
    expect(r.skillName).toBe('no-such-skill');
  });

  it('falls back through the chain: runOverride backend, then builtinBackend', () => {
    const viaRunOverride = resolveStepConfig({
      stepId: 'fix',
      builtinSystemPrompt: BUILTIN_PROMPT,
      builtinModel: BUILTIN_MODEL,
      runOverride: { backend: 'codex-cli' },
      skills,
    });
    expect(viaRunOverride.backend).toBe('codex-cli');

    const viaBuiltin = resolveStepConfig({
      stepId: 'fix',
      builtinSystemPrompt: BUILTIN_PROMPT,
      builtinModel: BUILTIN_MODEL,
      builtinBackend: 'claude-cli',
      skills,
    });
    expect(viaBuiltin.backend).toBe('claude-cli');
  });
});
