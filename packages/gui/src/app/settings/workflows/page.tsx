import Link from 'next/link';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { AUTOFIX_STEP_IDS, BUILTIN_TRIAGE_STEP_IDS } from '@cezar/core';
import { WorkflowsForm, type SkillMeta, type BindingRow } from './workflows-form';
import type { WorkflowBackend } from '@/lib/supabase/types';

interface RepoSkillsRow {
  commit_sha: string | null;
  skills: unknown;
  fetched_at: string | null;
}

interface WorkflowBindingDbRow {
  step_id: string;
  skill_name: string | null;
  backend: WorkflowBackend | null;
  model: string | null;
  extra_tools: unknown;
}

function parseSkills(raw: unknown): SkillMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s): SkillMeta | null => {
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
    .filter((s): s is SkillMeta => s !== null);
}

export default async function WorkflowsPage() {
  const workspace = await getActiveWorkspace();

  if (!workspace) {
    return (
      <div className="px-8 py-6">
        <header className="mb-6 border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
        </header>
        <div className="rounded-lg border border-dashed border-border bg-bg-elevated p-8 text-center text-sm text-fg-muted">
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
      .select('step_id, skill_name, backend, model, extra_tools')
      .eq('workspace_id', workspace.id)
      .is('repo', null)
      .returns<WorkflowBindingDbRow[]>(),
  ]);

  const skills = parseSkills(skillsRow?.skills);
  const bindings: BindingRow[] = (bindingRows ?? []).map((r) => ({
    stepId: r.step_id,
    skillName: r.skill_name ?? null,
    backend: r.backend ?? null,
    model: r.model ?? null,
    extraTools: Array.isArray(r.extra_tools)
      ? (r.extra_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
  }));

  const isAdmin = workspace.role === 'admin';

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <div className="flex items-center gap-3 text-sm text-fg-subtle">
          <Link href="/settings" className="hover:text-fg">Settings</Link>
          <span>/</span>
          <span className="text-fg">Workflows</span>
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Workflows</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Map repo skills, agent backends, and models onto each pipeline step.
          {!isAdmin && <span className="ml-2 text-fg-subtle">(read-only — admin required to edit)</span>}
        </p>
      </header>

      <WorkflowsForm
        autofixStepIds={AUTOFIX_STEP_IDS}
        triageStepIds={BUILTIN_TRIAGE_STEP_IDS}
        skills={skills}
        bindings={bindings}
        commitSha={skillsRow?.commit_sha ?? null}
        fetchedAt={skillsRow?.fetched_at ?? null}
        readOnly={!isAdmin}
      />
    </div>
  );
}
