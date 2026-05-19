'use server';

import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export interface SearchSkillResult {
  kind: 'skill';
  name: string;
  description: string | null;
  isOverride: boolean;
}

export interface SearchActionResult {
  kind: 'action';
  name: string;
  description: string | null;
  actionKind: 'built-in' | 'user';
}

export interface SearchRunResult {
  kind: 'run';
  id: string;
  workflow: string;
  status: string;
  issueNumber: number | null;
  createdAt: string;
}

export type SearchResult = SearchSkillResult | SearchActionResult | SearchRunResult;

interface RepoSkillsRow {
  skills: unknown;
}
interface OverrideNameRow {
  skill_name: string;
}
interface ActionNameRow {
  name: string;
  description: string | null;
  kind: 'built-in' | 'user';
}
interface WorkflowRunRow {
  id: string;
  workflow: string;
  status: string;
  issue_number: number | null;
  created_at: string;
}

const SKILL_LIMIT = 6;
const ACTION_LIMIT = 6;
const RUN_LIMIT = 6;

/**
 * Workspace-scoped search over the catalog + recent runs. Intentionally
 * cheap: skills + actions are filtered in-memory and runs are filtered
 * server-side by title/issue_number.
 */
export async function searchWorkspace(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const workspace = await getActiveWorkspace();
  if (!workspace) return [];

  const supabase = createSupabaseAdminClient();
  const [{ data: skillsRow }, { data: overrides }, { data: actionRows }, { data: runs }] = await Promise.all([
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
      .from('actions')
      .select('name, description, kind')
      .eq('workspace_id', workspace.id)
      .returns<ActionNameRow[]>(),
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

  // Dedupe action rows by name, preferring the user row over the built-in.
  const actionByName = new Map<string, ActionNameRow>();
  for (const r of actionRows ?? []) {
    const existing = actionByName.get(r.name);
    if (!existing || (existing.kind === 'built-in' && r.kind === 'user')) {
      actionByName.set(r.name, r);
    }
  }
  const actions: SearchActionResult[] = Array.from(actionByName.values())
    .filter((a) => `${a.name} ${a.description ?? ''}`.toLowerCase().includes(q))
    .slice(0, ACTION_LIMIT)
    .map((a) => ({
      kind: 'action',
      name: a.name,
      description: a.description,
      actionKind: a.kind,
    }));

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

  return [...skills, ...actions, ...runMatches];
}
