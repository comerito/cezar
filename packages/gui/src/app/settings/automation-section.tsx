'use client';

import { useActionState, useState } from 'react';
import { saveAutomationToggles, type SaveAutomationState } from './automation-actions';

interface AutomationSectionProps {
  autoTriageEnabled: boolean;
  autofixEnabled: boolean;
  separateCommentPerStep: boolean;
  readOnly: boolean;
}

export function AutomationSection({
  autoTriageEnabled,
  autofixEnabled,
  separateCommentPerStep,
  readOnly,
}: AutomationSectionProps) {
  const [state, formAction, pending] = useActionState<SaveAutomationState, FormData>(saveAutomationToggles, {});
  const [autofix, setAutofix] = useState(autofixEnabled);

  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      {state.ok && (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">Automation settings saved.</div>
      )}
      {state.error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">{state.error}</div>
      )}

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
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-600 dark:text-amber-400">
          ⚠️ With auto-fix on, Cezar will open draft PRs without a human in the loop (only on bugs above the confidence threshold). Review the draft before merging.
        </div>
      )}

      <Toggle
        name="separateCommentPerStep"
        label="One comment per workflow step"
        hint="Off (default): a single living comment is edited as the run progresses. On: each step posts its own comment."
        defaultChecked={separateCommentPerStep}
        readOnly={readOnly}
      />

      {!readOnly && (
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save automation settings'}
        </button>
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
    <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-elevated p-4">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={readOnly}
        onChange={(e) => onChange?.(e.target.checked)}
        className="mt-1 h-4 w-4 accent-accent"
      />
      <span className="space-y-1">
        <span className="block text-sm font-medium text-fg">{label}</span>
        <span className="block text-xs text-fg-muted">{hint}</span>
      </span>
    </label>
  );
}
