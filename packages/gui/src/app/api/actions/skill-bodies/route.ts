import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { readSkillBody } from '@/lib/skill-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ParsedSkill {
  name: string;
  path: string;
}

/**
 * Resolves the markdown bodies of the named skills against the workspace's
 * cached skill catalog (a single repo_skills row). Lets the action detail
 * page show what the runtime will actually assemble into the prompt.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new Response('Not authenticated', { status: 401 });

  const workspace = await getActiveWorkspace();
  if (!workspace) return new Response('No workspace selected', { status: 400 });

  const names = (req.nextUrl.searchParams.get('names') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return Response.json({ bodies: {} });

  const supabase = createSupabaseAdminClient();
  const { data } = await supabase
    .from('repo_skills')
    .select('skills')
    .eq('workspace_id', workspace.id)
    .eq('repo', workspace.repoName)
    .maybeSingle<{ skills: unknown }>();

  const arr = Array.isArray(data?.skills) ? (data!.skills as Array<Record<string, unknown>>) : [];
  const parsed: ParsedSkill[] = arr
    .map((s) => {
      const name = typeof s.name === 'string' ? s.name : null;
      const path = typeof s.path === 'string' ? s.path : null;
      if (!name || !path) return null;
      return { name, path };
    })
    .filter((s): s is ParsedSkill => s !== null);

  const bodies: Record<string, string> = {};
  await Promise.all(
    names.map(async (n) => {
      const match = parsed.find((p) => p.name === n);
      if (!match) {
        bodies[n] = '(skill not found in catalog — run Sync from repo on the Skills page)';
        return;
      }
      const body = await readSkillBody(workspace.repoOwner, workspace.repoName, match.path);
      bodies[n] = body ?? '(body not cached — Sync from repo)';
    }),
  );

  return Response.json({ bodies });
}
