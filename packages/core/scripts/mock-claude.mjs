#!/usr/bin/env node
/**
 * Mock `claude` binary for local autofix development and CI.
 *
 * Honors the same NDJSON stream-json output contract as the real CLI so
 * `ClaudeCodeCliRunner` doesn't need to know it's running a stub. Reads
 * its role from `--append-system-prompt`, emits a hardcoded plausible
 * structured-output response, exits 0.
 *
 * Wired in via `ClaudeCodeCliRunner.bin` when `CEZAR_DRY_RUN=1`.
 *
 *   CEZAR_DRY_RUN=1 yarn workspace @cezar/runner cezar-runner start ...
 *
 * Useful for end-to-end testing the workflow engine / cockpit / event
 * persistence without burning Anthropic tokens.
 */

import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);

// Pull the values we care about out of argv.
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const systemPrompt = argValue('--append-system-prompt') ?? '';
const sessionId = argValue('--session-id') ?? randomUUID();
const model = argValue('--model') ?? 'mock-model';
const cwd = process.cwd();

// Detect the role from the system prompt. The four built-in autofix
// agents all start their prompts with a fixed phrase, so a simple
// substring match is enough.
function detectRole(prompt) {
  if (prompt.includes('VERIFY-IN-REPO agent')) return 'verify';
  if (prompt.includes('ANALYZER agent')) return 'analyzer';
  if (prompt.includes('FIXER agent')) return 'fixer';
  if (prompt.includes('REVIEWER agent')) return 'reviewer';
  return 'generic';
}

function responseFor(role) {
  switch (role) {
    case 'verify':
      return {
        isRealUnfixedDefect: true,
        reason: '(mock) verified as a real, still-unfixed defect',
        confidence: 0.9,
      };
    case 'analyzer':
      return {
        summary: '(mock) located bug in stubbed module',
        suspectedFiles: ['src/mock.ts'],
        hypothesis: '(mock) the stubbed handler returns the wrong shape; fix the return type to match the schema',
        reproductionNotes: '(mock) run `yarn test src/mock.test.ts`',
        confidence: 0.85,
      };
    case 'fixer':
      return {
        changedFiles: [],
        approach: '(mock) no edits made — dry-run binary stops here',
        testCommandsRun: [],
        remainingConcerns: ['this is a mock response from scripts/mock-claude.mjs'],
      };
    case 'reviewer':
      return {
        verdict: 'pass',
        summary: '(mock) dry-run reviewer always passes',
        issues: [],
        suggestions: [],
      };
    default:
      return { mock: true, role, note: '(mock) generic dry-run response' };
  }
}

const role = detectRole(systemPrompt);
const responseObject = responseFor(role);
const responseText = JSON.stringify(responseObject, null, 2);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const usage = {
  input_tokens: 100,
  output_tokens: 40,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

// 1. system / init banner.
emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model,
  cwd,
  tools: [],
});

// 2. one assistant turn carrying the structured JSON as a text block.
//    Claude Code's real envelope uses the same shape; ClaudeCodeCliRunner
//    extracts text via `message.content[*].type === 'text'`.
emit({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: responseText }],
    usage,
  },
});

// 3. terminal result message.
emit({
  type: 'result',
  subtype: 'success',
  result: responseText,
  is_error: false,
  usage,
  total_cost_usd: 0.0001,
});

process.exit(0);
