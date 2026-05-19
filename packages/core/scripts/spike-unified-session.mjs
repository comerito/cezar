#!/usr/bin/env node
/**
 * Phase A0 spike — validate the persistent-session autofix premise on a
 * real claude CLI before committing to Phase A/B.
 *
 * What it does:
 *   1. Spawns one `claude --input-format stream-json --output-format
 *      stream-json` child (no `-p`).
 *   2. Pins a stable session id so we can later try `claude --resume`.
 *   3. Sends four `## PHASE: …` user messages in sequence.
 *   4. Captures per-phase `usage` / `cache_read_input_tokens` deltas.
 *   5. Writes a report to docs/spikes/spike-unified-<timestamp>.md.
 *
 * What it validates (per docs/REFACTOR-PLAN-persistent-autofix-session.md §7):
 *   Q1 — does each `## PHASE:` marker yield valid JSON per its schema
 *        (≥80% across phases) ?
 *   Q2 — what is cache_read_input_tokens / total_input by phase 4 ?
 *        (target ≥50% for the reviewer phase)
 *   Q3 — does `~/.claude/sessions/<session-id>.json` exist after the
 *        session ends, and does `claude --resume <session-id>` re-enter
 *        the conversation ?
 *
 * Usage:
 *   node packages/core/scripts/spike-unified-session.mjs \
 *     [--issue <issue-number>] [--worktree <path>] [--model <model>]
 *
 * Defaults:
 *   --issue     1950                (the timeout case we're calibrating)
 *   --worktree  cwd
 *   --model     claude-sonnet-4-6
 *
 * Requires:
 *   - claude CLI installed and authenticated (`claude auth`)
 *   - For the issue body fetch: GITHUB_TOKEN with read access to the repo
 *     (or skip fetch via --fake-issue)
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

// ─── CLI args ────────────────────────────────────────────────────────
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const issueNumber = Number(arg('--issue', '1950'));
const worktree = arg('--worktree', process.cwd());
const model = arg('--model', 'claude-sonnet-4-6');
const fakeIssue = process.argv.includes('--fake-issue');
const sessionId = randomUUID();

// ─── Build unified prompt — minimal draft just for the spike ─────────
const UNIFIED_PROMPT = `You are the Cezar AUTOFIX agent. Across this conversation you will play four roles in sequence.

The user will mark each phase with a "## PHASE: <NAME>" line. When you see one, switch role and respond with a single JSON object matching the schema for that phase. Do NOT proceed to the next phase on your own — wait for the next phase marker.

## PHASE: VERIFY-IN-REPO
Confirm the reported issue is a real, still-unfixed defect.
Schema:
{ "isRealUnfixedDefect": true|false, "reason": "short paragraph", "confidence": 0.0-1.0 }

## PHASE: ANALYZER
Locate the root cause. Read-only.
Schema:
{ "summary": "one-line", "suspectedFiles": ["..."], "hypothesis": "2-4 sentences", "confidence": 0.0-1.0 }
OR
{ "noActionNeeded": true, "reason": "..." }

## PHASE: FIXER
Implement the smallest correct fix.
Schema:
{ "changedFiles": ["..."], "approach": "2-4 sentences", "testCommandsRun": ["..."] }

## PHASE: REVIEWER
Review your own fix.
Schema:
{ "verdict": "pass"|"fail", "summary": "2-4 sentences", "issues": [...] }

## Output rules
- Each phase ends with EXACTLY one JSON object — no markdown fences, no prose before/after.
- Use paths relative to your CWD; never absolute prefixes like /repo.
- Batch parallel reads in one turn when exploring multi-file context.
- Stop early once you can write the phase JSON.
`;

// ─── Fetch issue body (optional) ─────────────────────────────────────
const SYNTHETIC_ISSUE = {
  title: 'bug: spike — synthetic test bug',
  body: 'Synthetic issue body for the Phase A0 spike. Cache behavior measurement only; no real bug fix expected.',
};

async function fetchIssue() {
  if (fakeIssue) return SYNTHETIC_ISSUE;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[spike] No GITHUB_TOKEN; using synthetic issue. Pass --fake-issue to silence this.');
    return SYNTHETIC_ISSUE;
  }
  const resp = await fetch(`https://api.github.com/repos/open-mercato/open-mercato/issues/${issueNumber}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!resp.ok) {
    console.error(`[spike] GitHub fetch failed (${resp.status}); using synthetic issue.`);
    return SYNTHETIC_ISSUE;
  }
  const data = await resp.json();
  return { title: data.title, body: (data.body ?? '').slice(0, 4000) };
}

// ─── Send a user message over stream-json stdin ──────────────────────
function userMessage(text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    session_id: sessionId,
  }) + '\n';
}

// ─── Build the four phase prompts ────────────────────────────────────
function phasePrompts(issue) {
  return [
    {
      phase: 'verify-in-repo',
      schemaKeys: ['isRealUnfixedDefect', 'reason'],
      text: `## PHASE: VERIFY-IN-REPO\n\nIssue #${issueNumber}: ${issue.title}\n\nBody:\n${issue.body}\n\nIs this a real, still-unfixed defect?`,
    },
    {
      phase: 'analyzer',
      schemaKeys: ['summary', 'suspectedFiles'],
      altKeys: ['noActionNeeded'],
      text: `## PHASE: ANALYZER\n\nNow analyze the root cause. Use Read/Grep/Glob — do not edit files.`,
    },
    {
      phase: 'fixer',
      schemaKeys: ['changedFiles', 'approach'],
      text: `## PHASE: FIXER\n\n(Spike mode — do NOT actually edit files; pretend you did and emit the JSON describing what you would have changed.)`,
    },
    {
      phase: 'reviewer',
      schemaKeys: ['verdict', 'summary'],
      text: `## PHASE: REVIEWER\n\nReview the plan from the FIXER phase.`,
    },
  ];
}

// ─── Spawn claude + run the conversation ─────────────────────────────
async function main() {
  const issue = await fetchIssue();
  const phases = phasePrompts(issue);
  const metrics = [];
  const startedAt = Date.now();

  console.error(`[spike] session id: ${sessionId}`);
  console.error(`[spike] model:      ${model}`);
  console.error(`[spike] cwd:        ${worktree}`);
  console.error(`[spike] issue:      #${issueNumber} — ${issue.title}\n`);

  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--append-system-prompt', UNIFIED_PROMPT,
    '--permission-mode', 'acceptEdits',
    '--session-id', sessionId,
    '--model', model,
  ];

  const bin = process.env.CLAUDE_BIN ?? 'claude';
  const child = spawn(bin, args, { cwd: worktree, env: process.env });

  // Per-phase accumulators populated by the stdout reader.
  let currentPhaseIdx = -1;
  let phaseStart = startedAt;
  let phaseInputTokens = 0;
  let phaseCacheRead = 0;
  let phaseOutputTokens = 0;
  let phaseText = '';

  function flushPhase(finalUsage) {
    if (currentPhaseIdx < 0) return;
    const ph = phases[currentPhaseIdx];
    metrics.push({
      phase: ph.phase,
      elapsedMs: Date.now() - phaseStart,
      inputTokens: phaseInputTokens + (finalUsage?.input_tokens ?? 0),
      cacheReadTokens: phaseCacheRead + (finalUsage?.cache_read_input_tokens ?? 0),
      outputTokens: phaseOutputTokens + (finalUsage?.output_tokens ?? 0),
      rawText: phaseText,
      schemaOk: validateSchema(phaseText, ph),
    });
    phaseInputTokens = 0;
    phaseCacheRead = 0;
    phaseOutputTokens = 0;
    phaseText = '';
  }

  function validateSchema(text, ph) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { parsed: false, reason: 'no JSON found' };
    try {
      const obj = JSON.parse(match[0]);
      const hasMain = ph.schemaKeys.every((k) => k in obj);
      const hasAlt = ph.altKeys ? ph.altKeys.every((k) => k in obj) : false;
      if (hasMain || hasAlt) return { parsed: true };
      return { parsed: false, reason: `missing keys; got ${Object.keys(obj).join(', ')}` };
    } catch (err) {
      return { parsed: false, reason: `JSON.parse: ${err.message}` };
    }
  }

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        handleClaudeMessage(msg);
      } catch {
        /* ignore */
      }
    }
  });

  function handleClaudeMessage(msg) {
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') phaseText += block.text;
      }
      const u = msg.message?.usage ?? {};
      phaseInputTokens += u.input_tokens ?? 0;
      phaseCacheRead += u.cache_read_input_tokens ?? 0;
      phaseOutputTokens += u.output_tokens ?? 0;
    }
    if (msg.type === 'result') {
      flushPhase(msg.usage);
    }
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[claude stderr] ${chunk}`));

  child.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`\n[spike] claude binary '${bin}' not found on PATH. Set CLAUDE_BIN or install claude.`);
      process.exit(2);
    }
    throw err;
  });

  // Drive the conversation phase by phase. Wait for the previous phase's
  // `result` message before sending the next.
  async function sendPhase(idx) {
    currentPhaseIdx = idx;
    phaseStart = Date.now();
    console.error(`[spike] → phase ${idx + 1}/${phases.length}: ${phases[idx].phase}`);
    child.stdin.write(userMessage(phases[idx].text));
    // Wait until flushPhase has appended a metric for this idx.
    while (metrics.length <= idx) {
      await new Promise((r) => setTimeout(r, 500));
      if (child.exitCode != null) throw new Error(`claude exited prematurely (code ${child.exitCode})`);
    }
  }

  try {
    for (let i = 0; i < phases.length; i++) await sendPhase(i);
  } catch (err) {
    console.error(`[spike] failed: ${err.message}`);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('close', r));
  }

  // ─── Q3 disk-resume check ─────────────────────────────────────────
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  let q3DiskCheck = { exists: false, path: null };
  try {
    const candidate = join(sessionsDir, `${sessionId}.json`);
    await access(candidate);
    q3DiskCheck = { exists: true, path: candidate };
  } catch {
    // Try a different layout claude may use.
    if (existsSync(sessionsDir)) {
      q3DiskCheck.path = `(no exact match for ${sessionId} under ${sessionsDir} — check naming)`;
    }
  }

  // ─── Compute Q-summary ────────────────────────────────────────────
  const q1Pass = metrics.length === phases.length && metrics.every((m) => m.schemaOk.parsed);
  const reviewerPhase = metrics.find((m) => m.phase === 'reviewer');
  const q2Ratio = reviewerPhase
    ? reviewerPhase.cacheReadTokens / Math.max(1, reviewerPhase.inputTokens + reviewerPhase.cacheReadTokens)
    : 0;

  const elapsedMs = Date.now() - startedAt;

  // ─── Write the report ─────────────────────────────────────────────
  const spikesDir = join(repoRoot, 'docs', 'spikes');
  await mkdir(spikesDir, { recursive: true });
  const reportPath = join(spikesDir, `spike-unified-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  const report = buildReport({
    sessionId, model, issueNumber, issueTitle: issue.title, worktree, elapsedMs,
    metrics, q1Pass, q2Ratio, q3DiskCheck,
  });
  await writeFile(reportPath, report, 'utf8');

  console.error(`\n[spike] complete (${(elapsedMs / 1000).toFixed(1)}s)`);
  console.error(`[spike] Q1 phase markers: ${q1Pass ? 'PASS' : 'FAIL'} (${metrics.filter((m) => m.schemaOk.parsed).length}/${phases.length})`);
  console.error(`[spike] Q2 reviewer cache ratio: ${(q2Ratio * 100).toFixed(1)}%  (target ≥50%)`);
  console.error(`[spike] Q3 session on disk: ${q3DiskCheck.exists ? 'YES' : 'NOT FOUND'}  ${q3DiskCheck.path ?? ''}`);
  console.error(`[spike] report: ${reportPath}`);
  console.error(`\nTo manually validate Q3 resume: cd ${worktree} && claude --resume ${sessionId}`);
}

function buildReport({ sessionId, model, issueNumber, issueTitle, worktree, elapsedMs, metrics, q1Pass, q2Ratio, q3DiskCheck }) {
  const rows = metrics.map((m) =>
    `| ${m.phase} | ${(m.elapsedMs / 1000).toFixed(1)}s | ${m.inputTokens} | ${m.cacheReadTokens} | ${m.outputTokens} | ${m.schemaOk.parsed ? '✅' : '❌ ' + m.schemaOk.reason} |`
  ).join('\n');

  return `# Phase A0 spike report

Generated: ${new Date().toISOString()}

## Inputs

- session id: \`${sessionId}\`
- model: \`${model}\`
- issue: #${issueNumber} — ${issueTitle}
- cwd: \`${worktree}\`
- wall clock: ${(elapsedMs / 1000).toFixed(1)}s

## Per-phase metrics

| phase | elapsed | input | cache_read | output | schema |
|---|---|---|---|---|---|
${rows}

## Q1 — phase markers validate per schema

${q1Pass ? '**PASS** — every phase returned JSON matching its schema.' : `**FAIL** — see schema column above.`}

Acceptance: ≥80% of phases parse cleanly.

## Q2 — cache reuse by reviewer phase

Reviewer cache ratio: **${(q2Ratio * 100).toFixed(1)}%** (target ≥50%).

Cache ratio per phase = cache_read_input_tokens / (input_tokens + cache_read_input_tokens). The reviewer is the last phase, so this is the best snapshot of cumulative cache reuse.

## Q3 — session resume via disk history

\`~/.claude/sessions/<session-id>.json\`: ${q3DiskCheck.exists ? `**FOUND** at ${q3DiskCheck.path}` : '**NOT FOUND**'}

To validate the actual resume behavior manually:

\`\`\`
cd ${worktree}
claude --resume ${sessionId}
\`\`\`

If that prompt drops you into the conversation, Q3 is fully validated.

## Go / no-go

| gate | result |
|---|---|
| Q1 phase markers (≥80% pass) | ${q1Pass ? '✅' : '❌'} |
| Q2 reviewer cache ≥ 50% | ${q2Ratio >= 0.5 ? '✅' : '⚠️ measured ' + (q2Ratio * 100).toFixed(1) + '%'} |
| Q3 disk history file written | ${q3DiskCheck.exists ? '✅' : '⚠️ check naming'} |

If all three are ✅, proceed with Phase A. If any are ❌ revisit the
unified-prompt premise before writing more code.
`;
}

main().catch((err) => {
  console.error('[spike] crashed:', err);
  process.exit(1);
});
