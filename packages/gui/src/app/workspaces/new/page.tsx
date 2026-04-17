'use client';

import { useActionState } from 'react';
import { createWorkspace, type CreateWorkspaceState } from '../actions';

export default function NewWorkspacePage() {
  const [state, formAction, pending] = useActionState<CreateWorkspaceState, FormData>(
    createWorkspace,
    {},
  );

  return (
    <div className="px-8 py-6">
      <header className="mb-8 border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Create Workspace</h1>
        <p className="mt-1 text-sm text-fg-muted">One workspace = one GitHub repository.</p>
      </header>

      <form action={formAction} className="max-w-md space-y-5">
        {state.error && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
            {state.error}
          </div>
        )}

        <Field label="Workspace name" name="name" placeholder="Open Mercato" />
        <Field label="Repository owner" name="repo_owner" placeholder="comerito" />
        <Field label="Repository name" name="repo_name" placeholder="open-mercato" />

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? 'Creating...' : 'Create workspace'}
        </button>
      </form>
    </div>
  );
}

function Field({
  label,
  name,
  placeholder,
}: {
  label: string;
  name: string;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        placeholder={placeholder}
        required
        className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none"
      />
    </div>
  );
}
