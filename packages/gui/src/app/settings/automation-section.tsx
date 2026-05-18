'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { saveAutomationToggles, type SaveAutomationState } from './automation-actions';

interface AutomationSectionProps {
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  actionAutoComment: boolean;
  readOnly: boolean;
}

export function AutomationSection({
  autoTriageEnabled,
  autofixEnabled,
  separateCommentPerStep,
  actionAutoComment,
  readOnly,
}: AutomationSectionProps) {
  const [state, formAction, pending] = useActionState<SaveAutomationState, FormData>(saveAutomationToggles, {});
  const [autofix, setAutofix] = useState(autofixEnabled);

  return (
    <form action={formAction} className="space-y-4">
      {state.ok && <Banner tone="ok">Automation settings saved.</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      <Toggle
        name="autoTriageEnabled"
        label="Auto-triage new issues"
        hint="When a GitHub issue is opened (or its title/body edited), Cezar runs the triage workflow — classifies it, sets a priority, applies labels, and posts a summary comment."
        defaultChecked={autoTriageEnabled}
        readOnly={readOnly}
      />

      <Toggle
        name="autofixEnabled"
        label="Auto-fix triaged bugs"
        hint="When on, Cezar opens a draft PR automatically on triaged bugs that clear the confidence threshold (config: autofix.minBugConfidence). PRs are always opened as drafts."
        defaultChecked={autofixEnabled}
        readOnly={readOnly}
        onChange={setAutofix}
      />

      {autofix && !autofixEnabled && (
        <Banner tone="warn">
          With auto-fix on, Cezar will open draft PRs without a human in the loop (only on bugs above the
          confidence threshold). Review the draft before merging.
        </Banner>
      )}

      <Toggle
        name="separateCommentPerStep"
        label="One comment per workflow step"
        hint="Off (default): a single living comment is edited as the run progresses. On: each step posts its own comment."
        defaultChecked={separateCommentPerStep}
        readOnly={readOnly}
      />

      <Toggle
        name="actionAutoComment"
        label="Auto-comment on actions"
        hint="Cezar leaves a short summary comment on the issue or PR after each action runs, explaining what it did and why. Skipped when the action already posted its own comment."
        defaultChecked={actionAutoComment}
        readOnly={readOnly}
      />

      {!readOnly && (
        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save automation settings'}
          </button>
        </div>
      )}
    </form>
  );
}

function Toggle({
  name,
  label,
  hint,
  defaultChecked,
  readOnly,
  onChange,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
  readOnly: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-md border border-outline-variant bg-surface-container/40 p-4 transition-colors',
        readOnly ? 'opacity-70' : 'hover:border-outline',
      )}
    >
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={readOnly}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-4 w-4 accent-primary"
      />
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-medium text-on-surface">{label}</span>
        <span className="block text-xs leading-relaxed text-on-surface-variant">{hint}</span>
      </span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error' | 'warn'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'border-primary/30 bg-primary/10 text-primary'
      : tone === 'warn'
        ? 'border-tertiary/40 bg-tertiary/10 text-tertiary'
        : 'border-error/40 bg-error/10 text-error';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', cls)} role="status">
      {children}
    </div>
  );
}
