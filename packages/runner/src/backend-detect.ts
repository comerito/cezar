import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface BackendCheck {
  backend: 'claude-cli' | 'codex-cli';
  binary: string;
  available: boolean;
  version?: string;
  hint?: string;
}

/**
 * Probes which subscription-CLI backends this host can serve by spawning
 * `<bin> --version`. Does NOT verify the CLI is *logged in* (that needs an
 * interactive flow); callers print a "run `claude login` / `codex login`" hint.
 */
export async function detectBackends(): Promise<BackendCheck[]> {
  const probes: Array<{ backend: BackendCheck['backend']; binary: string; loginCmd: string }> = [
    { backend: 'claude-cli', binary: 'claude', loginCmd: 'claude login' },
    { backend: 'codex-cli', binary: 'codex', loginCmd: 'codex login' },
  ];
  return Promise.all(
    probes.map(async ({ backend, binary, loginCmd }) => {
      try {
        const { stdout } = await exec(binary, ['--version'], { timeout: 10_000 });
        return { backend, binary, available: true, version: stdout.trim(), hint: `if not authenticated, run \`${loginCmd}\`` };
      } catch {
        return { backend, binary, available: false, hint: `install the \`${binary}\` CLI and run \`${loginCmd}\`` };
      }
    }),
  );
}
