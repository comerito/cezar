import { spawn } from 'node:child_process';

export interface SetupCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a single user-configured setup command (e.g. `yarn install`,
 * `yarn migrate`) inside the worktree. Output is streamed to `onLine` as it
 * arrives so the cockpit can show progress for long-running installs.
 *
 * Uses shell mode because users will typically write commands the way they'd
 * type them in a terminal (with pipes, env-vars, etc.). Trust boundary is the
 * same as a CI script — the worktree is a clone of the user's own repo and
 * the command list is configured by the workspace admin.
 */
export function runSetupCommand(
  command: string,
  cwd: string,
  onLine?: (line: string) => void,
): Promise<SetupCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';

    const handleChunk = (kind: 'out' | 'err') => (chunk: Buffer) => {
      const text = chunk.toString();
      if (kind === 'out') stdout += text;
      else stderr += text;
      if (onLine) {
        for (const line of text.split('\n')) {
          const trimmed = line.trimEnd();
          if (trimmed) onLine(trimmed);
        }
      }
    };

    child.stdout?.on('data', handleChunk('out'));
    child.stderr?.on('data', handleChunk('err'));
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: null, stdout, stderr: stderr + `\n${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });
}
