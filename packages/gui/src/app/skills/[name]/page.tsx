import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readSkillBody } from '@/lib/skill-body';
import { SkillDetailView, type SkillDetail } from './skill-detail-view';

interface RepoSkillsRow {
  commit_sha: string | null;
  skills: unknown;
  fetched_at: string | null;
}

interface WorkflowBindingDbRow {
  step_id: string;
  skill_name: string | null;
  backend: string | null;
  model: string | null;
  extra_tools: unknown;
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

export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);

  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected.{' '}
          <Link href="/workspaces/new" className="text-primary hover:underline">
            Create one first
          </Link>
          .
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
      .select('step_id, skill_name, backend, model, extra_tools')
      .eq('workspace_id', workspace.id)
      .is('repo', null)
      .returns<WorkflowBindingDbRow[]>(),
  ]);

  const parsed = parseSkills(skillsRow?.skills);
  const skill = parsed.find((s) => s.name === name);
  if (!skill) notFound();

  const bindings = (bindingRows ?? []).filter((b) => b.skill_name === skill.name);
  const isOverride = bindings.length > 0;

  const body = await readSkillBody(workspace.repoOwner, workspace.repoName, skill.path);

  const detail: SkillDetail = {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    body,
    source: isOverride ? 'override' : 'repo',
    stages: skill.suggestedStages,
    bindings: bindings.map((b) => ({
      stepId: b.step_id,
      backend: (b.backend as 'anthropic-api' | 'claude-cli' | 'codex-cli' | null) ?? null,
      model: b.model,
      extraTools: Array.isArray(b.extra_tools)
        ? (b.extra_tools as unknown[]).filter((t): t is string => typeof t === 'string')
        : [],
    })),
    commitSha: skillsRow?.commit_sha ?? null,
    fetchedAt: skillsRow?.fetched_at ?? null,
  };

  const isAdmin = workspace.role === 'admin';

  return <SkillDetailView skill={detail} readOnly={!isAdmin} />;
}
