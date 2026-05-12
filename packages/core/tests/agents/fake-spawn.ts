import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnFn } from '../../src/agents/claude-cli-runner.js';

export interface FakeSpawnRecord {
  command: string;
  args: readonly string[];
  cwd?: string;
}

/**
 * Build a fake `spawnFn` that feeds a canned set of stdout lines (NDJSON) to
 * the runner, then exits with `exitCode`. Records every spawn for assertions.
 * Pass `error` to simulate `ENOENT` (binary not found) etc.
 */
export function makeFakeSpawn(opts: {
  stdoutLines?: string[];
  stderr?: string;
  exitCode?: number;
  error?: NodeJS.ErrnoException;
}): { spawnFn: SpawnFn; calls: FakeSpawnRecord[] } {
  const calls: FakeSpawnRecord[] = [];

  const spawnFn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });

    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: { write: () => boolean; end: () => void };
      exitCode: number | null;
      killed: boolean;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };

    const lines = opts.stdoutLines ?? [];
    child.stdout = Readable.from((async function* () {
      for (const l of lines) yield `${l}\n`;
    })());
    child.stderr = Readable.from((async function* () {
      if (opts.stderr) yield opts.stderr;
    })());
    child.stdin = { write: () => true, end: () => {} };
    child.exitCode = null;
    child.killed = false;
    child.kill = (_signal?: NodeJS.Signals | number) => {
      child.killed = true;
      return true;
    };

    if (opts.error) {
      // Mirror Node's async error delivery.
      setImmediate(() => child.emit('error', opts.error));
      return child as unknown as ChildProcessWithoutNullStreams;
    }

    // Emit close once stdout has been fully consumed by the runner.
    child.stdout.on('end', () => {
      setImmediate(() => {
        const code = opts.exitCode ?? 0;
        child.exitCode = code;
        child.emit('exit', code, null);
        child.emit('close', code, null);
      });
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  };

  return { spawnFn, calls };
}
