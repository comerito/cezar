'use client';

import { useActionState } from 'react';
import { saveWorkspaceConfig, type SaveConfigState } from './actions';

interface SettingsFormProps {
  config: Record<string, unknown>;
  readOnly: boolean;
}

export function SettingsForm({ config, readOnly }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState<SaveConfigState, FormData>(
    saveWorkspaceConfig,
    {},
  );

  const sync = (config.sync ?? {}) as Record<string, unknown>;
  const autofix = (config.autofix ?? {}) as Record<string, unknown>;
  const models = (autofix.models ?? {}) as Record<string, unknown>;
  const maxTurns = (autofix.maxTurns ?? {}) as Record<string, unknown>;

  return (
    <form action={formAction} className="max-w-2xl space-y-10">
      {state.ok && (
        <div className="rounded-md border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">
          Settings saved.
        </div>
      )}
      {state.error && (
        <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
          {state.error}
        </div>
      )}

      {/* Sync settings */}
      <Section title="Sync">
        <NumberField name="sync.digestBatchSize" label="Digest batch size" value={val(sync.digestBatchSize, 20)} readOnly={readOnly} />
        <NumberField name="sync.duplicateBatchSize" label="Duplicate batch size" value={val(sync.duplicateBatchSize, 30)} readOnly={readOnly} />
        <RangeField name="sync.minDuplicateConfidence" label="Min duplicate confidence" value={val(sync.minDuplicateConfidence, 0.8)} readOnly={readOnly} />
        <Toggle name="sync.includeClosed" label="Include closed issues" checked={!!sync.includeClosed} readOnly={readOnly} />
        <NumberField name="sync.staleDaysThreshold" label="Stale days threshold" value={val(sync.staleDaysThreshold, 90)} readOnly={readOnly} />
        <NumberField name="sync.staleCloseDays" label="Stale close days" value={val(sync.staleCloseDays, 14)} readOnly={readOnly} />
      </Section>

      {/* Autofix settings */}
      <Section title="Autofix">
        <Toggle name="autofix.enabled" label="Autofix enabled" checked={!!autofix.enabled} readOnly={readOnly} />
        <TextField name="autofix.baseBranch" label="Base branch" value={str(autofix.baseBranch, 'main')} readOnly={readOnly} />
        <TextField name="autofix.branchPrefix" label="Branch prefix" value={str(autofix.branchPrefix, 'autofix/cezar-issue-')} readOnly={readOnly} />
        <NumberField name="autofix.maxAttemptsPerIssue" label="Max attempts per issue" value={val(autofix.maxAttemptsPerIssue, 2)} readOnly={readOnly} />
        <NumberField name="autofix.tokenBudgetPerAttempt" label="Token budget per attempt" value={val(autofix.tokenBudgetPerAttempt, 250000)} readOnly={readOnly} />
        <RangeField name="autofix.minBugConfidence" label="Min bug confidence" value={val(autofix.minBugConfidence, 0.7)} readOnly={readOnly} />
        <RangeField name="autofix.minAnalyzerConfidence" label="Min analyzer confidence" value={val(autofix.minAnalyzerConfidence, 0.5)} readOnly={readOnly} />
        <Toggle name="autofix.requireReviewPass" label="Require review pass" checked={autofix.requireReviewPass !== false} readOnly={readOnly} />
        <Toggle name="autofix.retryOnReviewFailure" label="Retry on review failure" checked={autofix.retryOnReviewFailure !== false} readOnly={readOnly} />
        <Toggle name="autofix.draftPr" label="Draft PR" checked={autofix.draftPr !== false} readOnly={readOnly} />
        <TextField name="autofix.prLabels" label="PR labels (comma-separated)" value={str((autofix.prLabels as string[] | undefined)?.join(', '), 'cezar-autofix')} readOnly={readOnly} />
      </Section>

      {/* Models */}
      <Section title="Models">
        <TextField name="autofix.models.analyzer" label="Analyzer model" value={str(models.analyzer, 'claude-sonnet-4-20250514')} readOnly={readOnly} />
        <TextField name="autofix.models.fixer" label="Fixer model" value={str(models.fixer, 'claude-sonnet-4-20250514')} readOnly={readOnly} />
        <TextField name="autofix.models.reviewer" label="Reviewer model" value={str(models.reviewer, 'claude-haiku-4-5-20251001')} readOnly={readOnly} />
      </Section>

      {/* Max turns */}
      <Section title="Max Turns">
        <NumberField name="autofix.maxTurns.analyzer" label="Analyzer" value={val(maxTurns.analyzer, 15)} readOnly={readOnly} />
        <NumberField name="autofix.maxTurns.fixer" label="Fixer" value={val(maxTurns.fixer, 30)} readOnly={readOnly} />
        <NumberField name="autofix.maxTurns.reviewer" label="Reviewer" value={val(maxTurns.reviewer, 10)} readOnly={readOnly} />
      </Section>

      {!readOnly && (
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? 'Saving...' : 'Save settings'}
        </button>
      )}
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</legend>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function TextField({ name, label, value, readOnly }: { name: string; label: string; value: string; readOnly: boolean }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-fg-muted">{label}</label>
      <input
        id={name} name={name} type="text" defaultValue={value} readOnly={readOnly}
        className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg read-only:opacity-60 focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function NumberField({ name, label, value, readOnly }: { name: string; label: string; value: number; readOnly: boolean }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-fg-muted">{label}</label>
      <input
        id={name} name={name} type="number" defaultValue={value} readOnly={readOnly}
        className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg read-only:opacity-60 focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function RangeField({ name, label, value, readOnly }: { name: string; label: string; value: number; readOnly: boolean }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs text-fg-muted">{label} ({value})</label>
      <input
        id={name} name={name} type="number" step="0.05" min="0" max="1" defaultValue={value} readOnly={readOnly}
        className="w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg read-only:opacity-60 focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function Toggle({ name, label, checked, readOnly }: { name: string; label: string; checked: boolean; readOnly: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm text-fg-muted">
      <input
        name={name} type="checkbox" defaultChecked={checked} disabled={readOnly}
        className="h-4 w-4 rounded border-border bg-bg accent-accent disabled:opacity-60"
      />
      {label}
    </label>
  );
}

function val(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
