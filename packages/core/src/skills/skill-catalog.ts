import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';

/**
 * A repo-discovered skill: a Markdown file under `<repoRoot>/<skillsDir>/`.
 * `body` is the file content with any leading `---` frontmatter block stripped;
 * `suggestedStages` comes from a `cezar-stages` frontmatter array (empty if the
 * file has no frontmatter or no such key). A skill never changes behavior on its
 * own — the GUI/CLI binding must reference it by `name`.
 */
export interface Skill {
  name: string;
  description?: string;
  body: string;
  path: string;
  suggestedStages: string[];
}

/**
 * Recursively discover `**\/*.md` skills under `<repoRoot>/<skillsDir>`.
 * Missing/empty directory ⇒ `[]` (an absent `.ai/skills/` is fully supported).
 * Results are sorted by `name`. No glob dependency — uses `readdir(recursive)`.
 */
export async function discoverSkills(repoRoot: string, skillsDir = '.ai/skills'): Promise<Skill[]> {
  const root = resolve(repoRoot, skillsDir);

  let entries: string[];
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    // ENOENT (or any read failure) on the skills dir ⇒ no skills.
    return [];
  }

  const mdFiles = entries.filter((rel) => extname(rel).toLowerCase() === '.md');
  const skills: Skill[] = [];
  for (const rel of mdFiles) {
    const absPath = join(root, rel);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf8');
    } catch {
      continue; // a directory matched by extname check, or vanished — skip it
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : basename(rel, extname(rel));
    const description = typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : undefined;
    const suggestedStages = Array.isArray(frontmatter['cezar-stages'])
      ? frontmatter['cezar-stages'].filter((s): s is string => typeof s === 'string')
      : [];
    skills.push({ name, description, body, path: absPath, suggestedStages });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Partition skills by whether their `suggestedStages` includes `stageId`. */
export function skillsForStage(skills: Skill[], stageId: string): { suggested: Skill[]; others: Skill[] } {
  const suggested: Skill[] = [];
  const others: Skill[] = [];
  for (const skill of skills) {
    (skill.suggestedStages.includes(stageId) ? suggested : others).push(skill);
  }
  return { suggested, others };
}

type FrontmatterValue = string | string[];

/**
 * Tiny purpose-built frontmatter parser — handles a leading `---\n … \n---\n`
 * block with `key: value` lines, `key: [a, b]` inline arrays, and `key:` then
 * `  - a` block arrays. Deliberately not a full YAML parser (no nesting, no
 * multi-line scalars) so we avoid a `js-yaml`/`gray-matter` dependency.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, FrontmatterValue>; body: string } {
  // Normalize CRLF so the delimiter regex is simple.
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: raw };

  const end = text.indexOf('\n---', 4);
  if (end === -1) return { frontmatter: {}, body: raw };

  const block = text.slice(4, end);
  // Body starts after the closing `---` line (and its trailing newline if any).
  const afterDelimiter = text.indexOf('\n', end + 1);
  const body = afterDelimiter === -1 ? '' : text.slice(afterDelimiter + 1);

  const frontmatter: Record<string, FrontmatterValue> = {};
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();

    if (rest === '') {
      // Possible block array: subsequent `  - item` lines.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(stripQuotes(lines[i + 1].replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      frontmatter[key] = items;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner
        ? inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0)
        : [];
      continue;
    }

    frontmatter[key] = stripQuotes(rest);
  }

  return { frontmatter, body };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
