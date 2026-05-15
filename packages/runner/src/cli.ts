#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { detectBackends } from './backend-detect.js';
import { RunnerDaemon, type RunnerDaemonConfig } from './runner-daemon.js';

const USAGE = `cezar-runner — Cezar agent runner (managed cloud / self-hosted)

Usage:
  cezar-runner login
      Check that the \`claude\` / \`codex\` CLIs are on PATH and report which
      backends this host can serve. Advises which \`<tool> login\` to run.

  cezar-runner start --url <saas-base-url> --token <runner-token> [options]
      --backends <csv>     backends to advertise (default: anthropic-api for
                           --kind cloud; auto-detected for self-hosted)
      --kind <k>           cloud | self-hosted   (default: self-hosted)
      --concurrency <n>    max concurrent jobs   (default: 1)
      --poll-interval <s>  seconds between claim attempts (default: 5)

  cezar-runner help
      Show this help.

The runner token comes from Settings → Runners (shown once). It is stored
hashed on the server; treat it like a password.`;

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(USAGE);
    return;
  }

  if (sub === 'login') {
    const checks = await detectBackends();
    let anyAvailable = false;
    for (const c of checks) {
      if (c.available) {
        anyAvailable = true;
        console.log(`✓ ${c.backend.padEnd(11)} — ${c.binary} ${c.version ?? ''}`.trimEnd());
        console.log(`    ${c.hint}`);
      } else {
        console.log(`✗ ${c.backend.padEnd(11)} — ${c.hint}`);
      }
    }
    if (!anyAvailable) {
      console.error('\nNo subscription-CLI backends available. Install `claude` and/or `codex`, then re-run.');
      process.exitCode = 1;
      return;
    }
    console.log('\nAt least one backend is available. Start the runner with `cezar-runner start --url ... --token ...`.');
    return;
  }

  if (sub === 'start') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        backends: { type: 'string' },
        kind: { type: 'string' },
        concurrency: { type: 'string' },
        'poll-interval': { type: 'string' },
      },
    });
    const url = values.url ?? process.env.CEZAR_RUNNER_URL;
    const token = values.token ?? process.env.CEZAR_RUNNER_TOKEN;
    if (!url || !token) {
      console.error('cezar-runner start: --url and --token are required (or set CEZAR_RUNNER_URL / CEZAR_RUNNER_TOKEN).');
      process.exitCode = 1;
      return;
    }
    const kind: RunnerDaemonConfig['kind'] = values.kind === 'cloud' ? 'cloud' : 'self-hosted';

    let backends: string[];
    if (values.backends) {
      backends = values.backends.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (kind === 'cloud') {
      backends = ['anthropic-api'];
    } else {
      const checks = await detectBackends();
      backends = checks.filter((c) => c.available).map((c) => c.backend);
      if (backends.length === 0) {
        console.error('No backends auto-detected for a self-hosted runner. Pass --backends explicitly (e.g. --backends claude-cli) or run `cezar-runner login`.');
        process.exitCode = 1;
        return;
      }
    }

    const daemon = new RunnerDaemon({
      url,
      token,
      backends,
      kind,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      pollIntervalSec: values['poll-interval'] ? Number(values['poll-interval']) : undefined,
    });
    await daemon.start();
    return;
  }

  console.error(`cezar-runner: unknown command '${sub}'\n`);
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[cezar-runner] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
