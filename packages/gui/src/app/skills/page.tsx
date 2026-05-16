import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { SkillsView, type SkillRow } from './skills-view';

interface RepoSkillsRow {
  commit_sha: string | null;
  skills: unknown;
  fetched_at: string | null;
}

interface WorkflowBindingDbRow {
  step_id: string;
  skill_name: string | null;
}

interface ParsedSkill {
  name: string;
  description: string | null;
  suggestedStages: string[];
  path: string;
}

function parseSkills(raw: unknown): ParsedSkill[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): ParsedSkill | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name : null;
      if (!name) return null;
      return {
        name,
        description: typeof o.description === 'string' ? o.description : null,
        suggestedStages: Array.isArray(o.suggestedStages)
          ? (o.suggestedStages as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        path: typeof o.path === 'string' ? o.path : '',
      };
    })
    .filter((s): s is ParsedSkill => s !== null);
}

function inferTrigger(stages: string[]): SkillRow['trigger'] {
  // Triage-ish stages typically fire on every sync; autofix-ish stages fire on demand.
  const triageish = new Set([
    'bug-detector',
    'priority',
    'categorize',
    'security',
    'quality',
    'good-first-issue',
    'missing-info',
    'claim-detector',
    'contributor-welcome',
    'recurring-questions',
    'duplicates',
    'stale',
    'done-detector',
    'auto-label',
  ]);
  return stages.some((s) => triageish.has(s)) ? 'on-sync' : 'cron';
}

function inferMode(stages: string[]): SkillRow['mode'] {
  // Skills that suggest themselves for autofix loop stages are "framed" (multi-step),
  // everything else is "inline".
  const framedish = new Set(['verify-in-repo', 'root-cause', 'fix', 'review', 'review-loop']);
  return stages.some((s) => framedish.has(s)) ? 'framed' : 'inline';
}

export default async function SkillsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <PageHeader />
        <div className="mt-6 rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected. Create one first.
        </div>
      </div>
    );
  }

  const supabase = createSupabaseAdminClient();
  const [{ data: skillsRow }, { data: bindingRows }] = await Promise.all([
    supabase
      .from('repo_skills')
      .select('commit_sha, skills, fetched_at')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle<RepoSkillsRow>(),
    supabase
      .from('workflow_bindings')
      .select('step_id, skill_name')
      .eq('workspace_id', workspace.id)
      .is('repo', null)
      .returns<WorkflowBindingDbRow[]>(),
  ]);

  const parsed = parseSkills(skillsRow?.skills);
  const overrideNames = new Set(
    (bindingRows ?? [])
      .map((b) => b.skill_name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  );

  const rows: SkillRow[] = parsed.map((s) => ({
    name: s.name,
    description: s.description,
    path: s.path,
    source: overrideNames.has(s.name) ? 'override' : 'repo',
    mode: inferMode(s.suggestedStages),
    trigger: inferTrigger(s.suggestedStages),
    status: 'enabled',
    lastRunIso: null,
    stages: s.suggestedStages,
  }));

  const isAdmin = workspace.role === 'admin';

  return (
    <SkillsView
      rows={rows}
      overridesCount={overrideNames.size}
      commitSha={skillsRow?.commit_sha ?? null}
      fetchedAt={skillsRow?.fetched_at ?? null}
      readOnly={!isAdmin}
    />
  );
}

function PageHeader() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-on-surface">Skills</h1>
      <p className="mt-1 text-sm text-on-surface-variant">
        Manage and monitor autonomous AI capabilities across your repositories.
      </p>
    </header>
  );
}
