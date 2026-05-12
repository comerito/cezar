import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeCodeCliRunner } from '../../src/agents/claude-cli-runner.js';
import { makeFakeSpawn } from './fake-spawn.js';

// A canned `claude -p --output-format stream-json --verbose` transcript:
// system/init → assistant tool_use → user tool_result → assistant text (JSON)
// → result (with usage).
const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Bash'] }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/x.ts' } }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'export const x = 1;', is_error: false }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is my analysis.\n\n{"summary":"x missing","suspectedFiles":["src/x.ts"],"hypothesis":"h","confidence":0.88}' }],
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 4000 },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Here is my analysis.\n\n{"summary":"x missing","suspectedFiles":["src/x.ts"],"hypothesis":"h","confidence":0.88}',
    usage: { input_tokens: 1200, output_tokens: 80 },
    total_cost_usd: 0.012,
  }),
];

const AnalyzerSchema = z.object({
  summary: z.string(),
  suspectedFiles: z.array(z.string()),
  hypothesis: z.string(),
  confidence: z.number(),
});

describe('ClaudeCodeCliRunner', () => {
  it('parses the stream-json transcript into events, tool calls, and structured output', async () => {
    const { spawnFn, calls } = makeFakeSpawn({ stdoutLines: TRANSCRIPT, exitCode: 0 });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const events: { type: string }[] = [];
    const res = await runner.run(
      {
        systemPrompt: 'You are the analyzer.',
        userPrompt: 'Find the root cause of #42.',
        cwd: '/work/wt',
        allowedTools: ['Read', 'Grep', 'Bash'],
        model: 'claude-sonnet-4-6',
        responseSchema: AnalyzerSchema,
      },
      (e) => events.push(e as { type: string }),
    );

    expect(res.parsed).toEqual({ summary: 'x missing', suspectedFiles: ['src/x.ts'], hypothesis: 'h', confidence: 0.88 });
    expect(res.toolCalls).toEqual([{ id: 'tu_1', name: 'Read', input: { file_path: 'src/x.ts' } }]);
    expect(res.tokensUsed).toBeGreaterThan(0);
    expect(res.budgetExceeded).toBe(false);

    expect(events).toContainEqual({ type: 'tool-call', id: 'tu_1', tool: 'Read', input: { file_path: 'src/x.ts' } });
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'tu_1', result: 'export const x = 1;', isError: false });
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });

    // argv sanity: headless print mode + the sandbox flags + cwd.
    const argv = calls[0].args;
    expect(calls[0].command).toBe('claude');
    expect(calls[0].cwd).toBe('/work/wt');
    expect(argv).toContain('-p');
    expect(argv).toContain('Find the root cause of #42.');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('stream-json');
    expect(argv).toContain('--append-system-prompt');
    expect(argv).toContain('You are the analyzer.');
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Read,Grep,Bash');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('acceptEdits');
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-sonnet-4-6');
  });

  it('throws a clear error when the claude binary is missing', async () => {
    const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { spawnFn } = makeFakeSpawn({ error: enoent });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] }),
    ).rejects.toThrow(/claude CLI not found on PATH/);
  });

  it('throws when the CLI exits non-zero', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [JSON.stringify({ type: 'system', subtype: 'init' })],
      stderr: 'fatal: not a git repository',
      exitCode: 1,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    await expect(
      runner.run({ systemPrompt: 's', userPrompt: 'u', cwd: '/tmp', allowedTools: ['Read'] }),
    ).rejects.toThrow(/claude CLI exited with code 1/);
  });

  it('falls back to the result message text when no streamed assistant text arrived', async () => {
    const { spawnFn } = makeFakeSpawn({
      stdoutLines: [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{"verdict":"pass"}', usage: { input_tokens: 10 } }),
      ],
      exitCode: 0,
    });
    const runner = new ClaudeCodeCliRunner({ spawnFn });
    const res = await runner.run({
      systemPrompt: 's',
      userPrompt: 'u',
      cwd: '/tmp',
      allowedTools: ['Read'],
      responseSchema: z.object({ verdict: z.string() }),
    });
    expect(res.parsed).toEqual({ verdict: 'pass' });
  });
});
