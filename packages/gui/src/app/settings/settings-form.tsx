'use client';

import { useActionState } from 'react';
import { cn } from '@/components/ui/cn';
import { saveWorkspaceConfig, type SaveConfigState } from './actions';
import { SettingsSubsection } from './settings-tabs';

export type IssueAutofixMode = 'off' | 'notify' | 'autonomous';

interface SettingsFormProps {
  config: Record<string, unknown>;
  issueAutofixMode: IssueAutofixMode;
  readOnly: boolean;
}

export function SettingsForm({ config, issueAutofixMode, readOnly }: SettingsFormProps) {
  const [state, formAction, pending] = useActionState<SaveConfigState, FormData>(
    saveWorkspaceConfig,
    {},
  );

  const sync = (config.sync ?? {}) as Record<string, unknown>;
  const autofix = (config.autofix ?? {}) as Record<string, unknown>;
  const models = (autofix.models ?? {}) as Record<string, unknown>;
  const maxTurns = (autofix.maxTurns ?? {}) as Record<string, unknown>;

  return (
    <form action={formAction} className="space-y-8">
      {state.ok && <Banner tone="ok">Settings saved.</Banner>}
      {state.error && <Banner tone="error">{state.error}</Banner>}

      <SettingsSubsection title="Issue autofix loop">
        <SelectField
          name="issueAutofixMode"
          label="Mode"
          value={issueAutofixMode}
          readOnly={readOnly}
          options={[
            { value: 'off', label: 'Off — do not sync bug issues' },
            { value: 'notify', label: 'Notify — surface candidates for one-click fix' },
            { value: 'autonomous', label: 'Autonomous — auto-dispatch on unmatched bugs' },
          ]}
        />
      </SettingsSubsection>

      <SettingsSubsection title="Sync">
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField name="sync.digestBatchSize"      label="Digest batch size"        value={val(sync.digestBatchSize, 20)}        readOnly={readOnly} />
          <NumberField name="sync.duplicateBatchSize"   label="Duplicate batch size"     value={val(sync.duplicateBatchSize, 30)}     readOnly={readOnly} />
          <RangeField  name="sync.minDuplicateConfidence" label="Min duplicate confidence" value={val(sync.minDuplicateConfidence, 0.8)} readOnly={readOnly} />
          <NumberField name="sync.staleDaysThreshold"   label="Stale days threshold"     value={val(sync.staleDaysThreshold, 90)}     readOnly={readOnly} />
          <NumberField name="sync.staleCloseDays"       label="Stale close days"         value={val(sync.staleCloseDays, 14)}         readOnly={readOnly} />
          <Toggle      name="sync.includeClosed"        label="Include closed issues"    checked={!!sync.includeClosed}               readOnly={readOnly} />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Autofix">
        <div className="grid gap-4 sm:grid-cols-2">
          <Toggle      name="autofix.enabled"               label="Autofix enabled"               checked={!!autofix.enabled}                 readOnly={readOnly} />
          <Toggle      name="autofix.draftPr"               label="Draft PR"                      checked={autofix.draftPr !== false}         readOnly={readOnly} />
          <TextField   name="autofix.baseBranch"            label="Base branch"                   value={str(autofix.baseBranch, 'main')}     readOnly={readOnly} />
          <TextField   name="autofix.branchPrefix"          label="Branch prefix"                 value={str(autofix.branchPrefix, 'autofix/cezar-issue-')} readOnly={readOnly} />
          <NumberField name="autofix.maxAttemptsPerIssue"   label="Max attempts per issue"        value={val(autofix.maxAttemptsPerIssue, 2)} readOnly={readOnly} />
          <NumberField name="autofix.tokenBudgetPerAttempt" label="Token budget per attempt"      value={val(autofix.tokenBudgetPerAttempt, 250000)} readOnly={readOnly} />
          <RangeField  name="autofix.minBugConfidence"      label="Min bug confidence"            value={val(autofix.minBugConfidence, 0.7)}  readOnly={readOnly} />
          <RangeField  name="autofix.minAnalyzerConfidence" label="Min analyzer confidence"       value={val(autofix.minAnalyzerConfidence, 0.5)} readOnly={readOnly} />
          <RangeField  name="autofix.autoProceedConfidence" label="Auto-proceed at confidence ≥" hint="0 = always ask" value={val(autofix.autoProceedConfidence, 0)} readOnly={readOnly} />
          <Toggle      name="autofix.requireReviewPass"     label="Require review pass"           checked={autofix.requireReviewPass !== false} readOnly={readOnly} />
          <Toggle      name="autofix.retryOnReviewFailure"  label="Retry on review failure"       checked={autofix.retryOnReviewFailure !== false} readOnly={readOnly} />
          <TextField   name="autofix.prLabels"              label="PR labels (comma-separated)"   value={str((autofix.prLabels as string[] | undefined)?.join(', '), 'cezar-autofix')} readOnly={readOnly} />
          <TextareaField
            name="autofix.setupCommands"
            label="Setup commands"
            hint="One per line — runs at the start of each attempt before the analyzer."
            value={(autofix.setupCommands as string[] | undefined)?.join('\n') ?? ''}
            readOnly={readOnly}
            placeholder={'yarn install\nyarn migrate'}
          />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Models">
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField name="autofix.models.analyzer" label="Analyzer" value={str(models.analyzer, 'claude-sonnet-4-6')}             readOnly={readOnly} />
          <TextField name="autofix.models.fixer"    label="Fixer"    value={str(models.fixer, 'claude-sonnet-4-6')}                readOnly={readOnly} />
          <TextField name="autofix.models.reviewer" label="Reviewer" value={str(models.reviewer, 'claude-haiku-4-5-20251001')}     readOnly={readOnly} />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="Max turns">
        <div className="grid gap-4 sm:grid-cols-3">
          <NumberField name="autofix.maxTurns.analyzer" label="Analyzer" value={val(maxTurns.analyzer, 15)} readOnly={readOnly} />
          <NumberField name="autofix.maxTurns.fixer"    label="Fixer"    value={val(maxTurns.fixer, 30)}    readOnly={readOnly} />
          <NumberField name="autofix.maxTurns.reviewer" label="Reviewer" value={val(maxTurns.reviewer, 10)} readOnly={readOnly} />
        </div>
      </SettingsSubsection>

      {!readOnly && (
        <div className="flex items-center justify-end gap-3 border-t border-outline-variant/60 pt-5">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </form>
  );
}

// ─── Form primitives ──────────────────────────────────────────────────

function FieldLabel({ htmlFor, label, hint }: { htmlFor: string; label: string; hint?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block">
      <span className="text-xs font-medium text-on-surface-variant">{label}</span>
      {hint && <span className="ml-2 text-[11px] text-outline">· {hint}</span>}
    </label>
  );
}

const INPUT_BASE =
  'h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none read-only:opacity-70 disabled:opacity-60';

function TextField({ name, label, value, readOnly, hint }: { name: string; label: string; value: string; readOnly: boolean; hint?: string }) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <input id={name} name={name} type="text" defaultValue={value} readOnly={readOnly} className={INPUT_BASE} />
    </div>
  );
}

function NumberField({ name, label, value, readOnly, hint }: { name: string; label: string; value: number; readOnly: boolean; hint?: string }) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <input id={name} name={name} type="number" defaultValue={value} readOnly={readOnly} className={INPUT_BASE} />
    </div>
  );
}

function RangeField({ name, label, value, readOnly, hint }: { name: string; label: string; value: number; readOnly: boolean; hint?: string }) {
  return (
    <div>
      <FieldLabel htmlFor={name} label={`${label} (${value})`} hint={hint} />
      <input
        id={name}
        name={name}
        type="number"
        step="0.05"
        min="0"
        max="1"
        defaultValue={value}
        readOnly={readOnly}
        className={INPUT_BASE}
      />
    </div>
  );
}

function TextareaField({
  name,
  label,
  value,
  readOnly,
  placeholder,
  hint,
}: {
  name: string;
  label: string;
  value: string;
  readOnly: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="sm:col-span-2">
      <FieldLabel htmlFor={name} label={label} hint={hint} />
      <textarea
        id={name}
        name={name}
        defaultValue={value}
        readOnly={readOnly}
        placeholder={placeholder}
        rows={4}
        className="block w-full resize-y rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-[12px] leading-[18px] text-on-surface placeholder:text-outline focus:border-primary focus:outline-none read-only:opacity-70"
      />
    </div>
  );
}

function SelectField({
  name,
  label,
  value,
  readOnly,
  options,
}: {
  name: string;
  label: string;
  value: string;
  readOnly: boolean;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="max-w-md">
      <FieldLabel htmlFor={name} label={label} />
      <select id={name} name={name} defaultValue={value} disabled={readOnly} className={INPUT_BASE}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ name, label, checked, readOnly }: { name: string; label: string; checked: boolean; readOnly: boolean }) {
  return (
    <label
      className={cn(
        'flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm',
        readOnly ? 'opacity-70' : 'hover:border-outline',
      )}
    >
      <input
        name={name}
        type="checkbox"
        defaultChecked={checked}
        disabled={readOnly}
        className="h-4 w-4 accent-primary"
      />
      <span className="text-on-surface">{label}</span>
    </label>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  const cls = tone === 'ok'
    ? 'border-primary/30 bg-primary/10 text-primary'
    : 'border-error/40 bg-error/10 text-error';
  return (
    <div className={cn('rounded-md border px-3 py-2 text-sm', cls)} role="status">
      {children}
    </div>
  );
}

function val(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
