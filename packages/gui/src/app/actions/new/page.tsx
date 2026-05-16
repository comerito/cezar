import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSessionUser } from '@/lib/auth';
import { getActiveWorkspace } from '@/lib/workspace';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

async function createNewAction(formData: FormData) {
  'use server';
  const user = await getSessionUser();
  if (!user) throw new Error('Not authenticated');
  const workspace = await getActiveWorkspace();
  if (!workspace) throw new Error('No workspace selected');
  if (workspace.role !== 'admin') throw new Error('Only admins can create actions');

  const name = ((formData.get('name') as string) ?? '').trim();
  const description = ((formData.get('description') as string) ?? '').trim();
  const target = ((formData.get('target') as string) ?? 'issue') === 'pr' ? 'pr' : 'issue';

  if (!name) throw new Error('Name is required');
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('Name must contain only letters, numbers, and dashes');

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('actions').insert({
    workspace_id: workspace.id,
    name,
    kind: 'user',
    description: description || null,
    system_prompt: '',
    skill_refs: [],
    target,
    triggers: ['manual'],
    effects: null,
    output_schema: null,
    enabled: true,
    created_by: user.id,
    updated_by: user.id,
  });
  if (error) throw new Error(error.message);

  revalidatePath('/actions');
  revalidatePath(`/actions/${encodeURIComponent(name)}`);
  redirect(`/actions/${encodeURIComponent(name)}`);
}

export default async function NewActionPage() {
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

  const readOnly = workspace.role !== 'admin';

  return (
    <div className="px-6 py-6">
      <header className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Link href="/actions" className="hover:text-on-surface">
            Actions
          </Link>
          <span aria-hidden>›</span>
          <span className="font-medium text-on-surface">New</span>
        </nav>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight text-on-surface">New action</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Creates an empty <code className="font-mono text-on-surface">user</code> action. You can fill in the
          system prompt, skills, and effects on the detail page.
        </p>
      </header>

      <form action={createNewAction} className="max-w-xl space-y-4 rounded-lg border border-outline-variant bg-surface-container-low p-5">
        <label className="block">
          <div className="mb-1.5 text-xs text-on-surface-variant">Name</div>
          <input
            name="name"
            required
            pattern="[a-z0-9-]+"
            placeholder="e.g. my-custom-triage"
            disabled={readOnly}
            className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-xs text-on-surface-variant">
            Lowercase letters, digits, and dashes. Must be unique in this workspace.
          </p>
        </label>
        <label className="block">
          <div className="mb-1.5 text-xs text-on-surface-variant">Description</div>
          <input
            name="description"
            placeholder="One-line description (optional)"
            disabled={readOnly}
            className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
          />
        </label>
        <label className="block">
          <div className="mb-1.5 text-xs text-on-surface-variant">Target</div>
          <select
            name="target"
            defaultValue="issue"
            disabled={readOnly}
            className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
          >
            <option value="issue">Issue</option>
            <option value="pr">Pull request</option>
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Link
            href="/actions"
            className="inline-flex h-9 items-center rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={readOnly}
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
