'use server';

import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface SearchSkillResult {
  kind: 'skill';
  name: string;
  description: string | null;
  isOverride: boolean;
}

export interface SearchRunResult {
  kind: 'run';
  id: string;
  workflow: string;
  status: string;
  issueNumber: number | null;
  createdAt: string;
}

export type SearchResult = SearchSkillResult | SearchRunResult;

interface RepoSkillsRow {
  skills: unknown;
}
interface OverrideNameRow {
  skill_name: string;
}
interface WorkflowRunRow {
  id: string;
  workflow: string;
  status: string;
  issue_number: number | null;
  created_at: string;
}

const SKILL_LIMIT = 6;
const RUN_LIMIT = 6;

/**
 * Workspace-scoped search over the catalog + recent runs. Intentionally
 * cheap: skills are filtered in-memory from the existing repo_skills cache
 * (which is already a single JSONB document per workspace), and runs are
 * filtered server-side by title/issue_number.
 */
export async function searchWorkspace(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const [{ data: skillsRow }, { data: overrides }, { data: runs }] = await Promise.all([
    supabase
      .from('repo_skills')
      .select('skills')
      .eq('workspace_id', workspace.id)
      .eq('repo', workspace.repoName)
      .maybeSingle<RepoSkillsRow>(),
    supabase
      .from('skill_overrides')
      .select('skill_name')
      .eq('workspace_id', workspace.id)
      .returns<OverrideNameRow[]>(),
    supabase
      .from('workflow_runs')
      .select('id, workflow, status, issue_number, created_at')
      .eq('workspace_id', workspace.id)
      .order('created_at', { ascending: false })
      .limit(40)
      .returns<WorkflowRunRow[]>(),
  ]);

  const overrideNames = new Set((overrides ?? []).map((o) => o.skill_name));

  const skillsArray = Array.isArray(skillsRow?.skills)
    ? (skillsRow!.skills as Array<{ name?: unknown; description?: unknown }>)
    : [];

  const skills: SearchSkillResult[] = skillsArray
    .map((s): SearchSkillResult | null => {
      if (!s || typeof s !== 'object') return null;
      const name = typeof s.name === 'string' ? s.name : null;
      if (!name) return null;
      const description = typeof s.description === 'string' ? s.description : null;
      const hay = `${name} ${description ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return null;
      return {
        kind: 'skill',
        name,
        description,
        isOverride: overrideNames.has(name),
      };
    })
    .filter((s): s is SearchSkillResult => s !== null)
    .slice(0, SKILL_LIMIT);

  const runMatches: SearchRunResult[] = (runs ?? [])
    .filter((r) => {
      const hay = `${r.workflow} #${r.issue_number ?? ''}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, RUN_LIMIT)
    .map((r) => ({
      kind: 'run',
      id: r.id,
      workflow: r.workflow,
      status: r.status,
      issueNumber: r.issue_number,
      createdAt: r.created_at,
    }));

  return [...skills, ...runMatches];
}
