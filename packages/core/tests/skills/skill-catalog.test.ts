import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { discoverSkills, skillsForStage } from '../../src/skills/skill-catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRepoRoot = join(here, '..', 'fixtures', 'skills-repo');

describe('discoverSkills', () => {
  it('finds skills, parses frontmatter, strips it from body, sorts by name', async () => {
    const skills = await discoverSkills(fixtureRepoRoot);
    expect(skills.map((s) => s.name)).toEqual(['deep-root-cause', 'house-style']);

    const deep = skills.find((s) => s.name === 'deep-root-cause')!;
    expect(deep.description).toBe("Extra root-cause guidance for this repo's domain.");
    expect(deep.suggestedStages).toEqual(['root-cause', 'verify-in-repo']);
    expect(deep.body).not.toContain('---');
    expect(deep.body).not.toContain('cezar-stages');
    expect(deep.body).toContain('# Repo root-cause notes');
    expect(deep.body).toContain('request-id middleware');
    expect(deep.path).toContain('root-cause.md');

    const house = skills.find((s) => s.name === 'house-style')!;
    expect(house.description).toBeUndefined();
    expect(house.suggestedStages).toEqual([]);
    expect(house.body).toContain('# House style');
    expect(house.body).toContain('Prefer named exports.');
  });

  it('returns [] when the skills directory does not exist', async () => {
    const skills = await discoverSkills(fixtureRepoRoot, '.does-not-exist/skills');
    expect(skills).toEqual([]);
  });

  it('returns [] for a repo with no .ai/skills at all', async () => {
    const skills = await discoverSkills(join(here, '..', 'fixtures', 'no-such-repo'));
    expect(skills).toEqual([]);
  });
});

describe('skillsForStage', () => {
  it('partitions skills by whether suggestedStages includes the stage', async () => {
    const skills = await discoverSkills(fixtureRepoRoot);
    const { suggested, others } = skillsForStage(skills, 'root-cause');
    expect(suggested.map((s) => s.name)).toEqual(['deep-root-cause']);
    expect(others.map((s) => s.name)).toEqual(['house-style']);

    const forFix = skillsForStage(skills, 'fix');
    expect(forFix.suggested).toEqual([]);
    expect(forFix.others.map((s) => s.name)).toEqual(['deep-root-cause', 'house-style']);
  });
});
