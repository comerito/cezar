'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import { createUserAction } from './new-action-action';
import { NAME_MAX, validateActionName } from './new-action-validation';

export interface NewActionFormProps {
  readOnly: boolean;
}

export function NewActionForm({ readOnly }: NewActionFormProps) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState<'issue' | 'pr'>('issue');
  const [nameError, setNameError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [touchedName, setTouchedName] = useState(false);
  const [pending, startTransition] = useTransition();

  // Live name validation once the user has interacted, so they aren't yelled
  // at on first focus.
  const liveNameError = touchedName ? validateActionName(name) : null;
  const submitDisabled =
    readOnly || pending || name.trim().length === 0 || validateActionName(name) !== null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);
    setTouchedName(true);

    const err = validateActionName(name);
    setNameError(err);
    if (err) return;

    startTransition(async () => {
      const result = await createUserAction({ name, description, target });
      if (!result.ok || !result.redirectTo) {
        setServerError(result.error ?? 'Could not create action');
        return;
      }
      router.push(result.redirectTo);
    });
  }

  const shownNameError = nameError ?? liveNameError;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="max-w-xl space-y-4 rounded-lg border border-outline-variant bg-surface-container-low p-5"
    >
      <label className="block">
        <div className="mb-1.5 text-xs text-on-surface-variant">Name</div>
        <input
          name="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (touchedName) setNameError(validateActionName(e.target.value));
            if (serverError) setServerError(null);
          }}
          onBlur={() => {
            setTouchedName(true);
            setNameError(validateActionName(name));
          }}
          autoComplete="off"
          spellCheck={false}
          maxLength={NAME_MAX}
          placeholder="e.g. my-custom-triage"
          disabled={readOnly || pending}
          aria-invalid={shownNameError ? 'true' : undefined}
          aria-describedby={shownNameError ? 'new-action-name-error' : 'new-action-name-hint'}
          className={cn(
            'h-9 w-full rounded-md border bg-surface px-3 text-sm text-on-surface focus:outline-none disabled:opacity-60',
            shownNameError
              ? 'border-error focus:border-error'
              : 'border-outline-variant focus:border-primary',
          )}
        />
        {shownNameError ? (
          <p id="new-action-name-error" className="mt-1 text-xs text-error">
            {shownNameError}
          </p>
        ) : (
          <p id="new-action-name-hint" className="mt-1 text-xs text-on-surface-variant">
            Lowercase letters, digits, and dashes. Must be unique in this workspace.
          </p>
        )}
      </label>

      <label className="block">
        <div className="mb-1.5 text-xs text-on-surface-variant">Description</div>
        <input
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description (optional)"
          disabled={readOnly || pending}
          maxLength={200}
          className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
        />
      </label>

      <label className="block">
        <div className="mb-1.5 text-xs text-on-surface-variant">Target</div>
        <select
          name="target"
          value={target}
          onChange={(e) => setTarget(e.target.value === 'pr' ? 'pr' : 'issue')}
          disabled={readOnly || pending}
          className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
        >
          <option value="issue">Issue</option>
          <option value="pr">Pull request</option>
        </select>
      </label>

      {serverError && (
        <div
          role="alert"
          className="rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-sm text-error"
        >
          {serverError}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Link
          href="/actions"
          className="inline-flex h-9 items-center rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={submitDisabled}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending && (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border-2 border-primary-on/40 border-t-primary-on"
            />
          )}
          {pending ? 'Creating…' : 'Create'}
        </button>
      </div>
    </form>
  );
}
