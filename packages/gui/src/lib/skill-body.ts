import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const REPOS_DIR = join(homedir(), '.cezar', 'repos');

/**
 * Reads a skill manifest file from the on-disk clone of the workspace repo
 * without triggering a fetch. Returns `null` when the clone doesn't exist
 * (i.e. the workspace has never synced its skills) or the file is missing.
 *
 * The `relativePath` must resolve inside the repo root — paths that escape
 * via `..` are rejected as a safety check.
 */
export async function readSkillBody(
  owner: string,
  repo: string,
  relativePath: string,
): Promise<string | null> {
  if (!relativePath || isAbsolute(relativePath)) return null;

  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  if (!existsSync(join(repoDir, '.git'))) return null;

  const resolved = resolve(repoDir, normalize(relativePath));
  if (!resolved.startsWith(repoDir + sep)) return null;

  try {
    return await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}
