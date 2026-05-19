import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const REPOS_DIR = join(homedir(), '.cezar', 'repos');

/**
 * Reads a skill manifest file from the on-disk clone of the workspace repo
 * without triggering a fetch. Returns `null` when the clone doesn't exist
 * or the file is missing.
 *
 * Skill paths in `repo_skills.skills[].path` are absolute (they come from
 * `discoverSkills(root, rel)` → `join(root, rel)` in `@cezar/core`). We
 * accept either an absolute path under the expected clone dir, or a
 * relative path joined against it. In both cases the resolved file must
 * still live inside the repo dir — anything escaping via `..` is rejected.
 */
export async function readSkillBody(
  owner: string,
  repo: string,
  storedPath: string,
): Promise<string | null> {
  if (!storedPath) return null;

  const repoDir = join(REPOS_DIR, `${owner}-${repo}`);
  if (!existsSync(join(repoDir, '.git'))) return null;

  let resolved: string;
  if (isAbsolute(storedPath)) {
    const inside = relative(repoDir, storedPath);
    // If the absolute path is under the *current* repo dir, use it. Otherwise
    // it was likely written by a different machine/clone — fall back to
    // joining the in-repo segment (everything after `.cezar/repos/<dir>/`).
    if (!inside.startsWith('..') && !isAbsolute(inside)) {
      resolved = resolve(repoDir, inside);
    } else {
      const marker = `${sep}.cezar${sep}repos${sep}`;
      const idx = storedPath.indexOf(marker);
      if (idx === -1) return null;
      // Skip past `/.cezar/repos/<repo-dir-name>/`
      const afterMarker = storedPath.slice(idx + marker.length);
      const slashAfter = afterMarker.indexOf(sep);
      if (slashAfter === -1) return null;
      const inRepo = afterMarker.slice(slashAfter + 1);
      resolved = resolve(repoDir, normalize(inRepo));
    }
  } else {
    resolved = resolve(repoDir, normalize(storedPath));
  }

  if (!resolved.startsWith(repoDir + sep)) return null;

  try {
    return await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}
