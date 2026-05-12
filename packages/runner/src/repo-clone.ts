import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const exec = promisify(execFile);

const REPOS_DIR = join(homedir(), '.cezar', 'runner-repos');

/**
 * Ensures a runner-local clone of `<owner>/<repo>` at `baseBranch`. Returns the
 * absolute repo root. Clones with a short-lived `x-access-token:<token>` URL
 * (the SaaS minted it per job — never persisted long-term).
 *
 * TODO(phase-4a): share with `packages/gui/src/lib/repo-clone.ts` — copied here
 * because the runner has no other runtime deps and shouldn't import from `gui`.
 */
export async function ensureRepoCloneLocal(
  owner: string,
  repo: string,
  githubToken: string,
  baseBranch = 'main',
): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });
  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  if (existsSync(join(repoDir, '.git'))) {
    await exec('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir });
    await exec('git', ['fetch', 'origin'], { cwd: repoDir });
    await exec('git', ['checkout', baseBranch], { cwd: repoDir }).catch(() =>
      exec('git', ['checkout', '-b', baseBranch, `origin/${baseBranch}`], { cwd: repoDir }),
    );
    await exec('git', ['reset', '--hard', `origin/${baseBranch}`], { cwd: repoDir });
  } else {
    await exec('git', ['clone', '--depth', '50', '--branch', baseBranch, cloneUrl, repoDir]);
  }
  return repoDir;
}
