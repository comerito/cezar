import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const exec = promisify(execFile);

const REPOS_DIR = join(homedir(), '.cezar', 'repos');

/**
 * Ensures a local clone of the repo exists and is up-to-date.
 * Returns the absolute path to the repo root.
 *
 * Clones to ~/.cezar/repos/<owner>-<repo>. If already cloned,
 * fetches latest from origin.
 */
export async function ensureRepoClone(
  owner: string,
  repo: string,
  githubToken: string,
  baseBranch: string = 'main',
): Promise<string> {
  await mkdir(REPOS_DIR, { recursive: true });

  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;

  if (existsSync(join(repoDir, '.git'))) {
    await exec('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir });
    await exec('git', ['fetch', 'origin'], { cwd: repoDir });
    await exec('git', ['checkout', baseBranch], { cwd: repoDir }).catch(() => {
      // branch might not exist locally yet
      return exec('git', ['checkout', '-b', baseBranch, `origin/${baseBranch}`], { cwd: repoDir });
    });
    await exec('git', ['reset', '--hard', `origin/${baseBranch}`], { cwd: repoDir });
  } else {
    await exec('git', ['clone', '--depth', '50', '--branch', baseBranch, cloneUrl, repoDir]);
  }

  return repoDir;
}
