'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import {
  FileIcon,
  PlayIcon,
  CheckIcon,
  RotateLeftIcon,
  PlusIcon,
  SparkleSmallIcon,
  CodeIcon,
  ChevronDownIcon,
} from '@/components/icons';

export interface SkillDetail {
  name: string;
  description: string | null;
  path: string;
  body: string | null;
  source: 'override' | 'repo' | 'built-in';
  stages: string[];
  bindings: Array<{
    stepId: string;
    backend: 'anthropic-api' | 'claude-cli' | 'codex-cli' | null;
    model: string | null;
    extraTools: string[];
  }>;
  commitSha: string | null;
  fetchedAt: string | null;
}

interface Props {
  skill: SkillDetail;
  readOnly: boolean;
}

const EXECUTION_MODES = [
  { value: 'continuous', label: 'Continuous Analysis' },
  { value: 'one-shot', label: 'One-Shot' },
  { value: 'review-loop', label: 'Review Loop' },
];

const TRIGGER_CONDITIONS = [
  { id: 'issue-created', label: 'Issue Created' },
  { id: 'label-added', label: 'Label Added' },
  { id: 'comment-posted', label: 'Comment Posted' },
  { id: 'check-failed', label: 'CI Check Failed' },
];

const CAPABILITIES = [
  { id: 'reasoning', label: 'REASONING', icon: <SparkleSmallIcon className="h-4 w-4" /> },
  { id: 'synthesis', label: 'SYNTHESIS', icon: <CodeIcon className="h-4 w-4" /> },
] as const;

export function SkillDetailView({ skill, readOnly }: Props) {
  const firstBinding = skill.bindings[0];
  const [executionMode, setExecutionMode] = useState(firstBinding?.backend ? 'one-shot' : 'continuous');
  const [triggers, setTriggers] = useState<Set<string>>(() => new Set(['issue-created']));
  const [outputs, setOutputs] = useState<string[]>(['stdout.json']);
  const [capabilities, setCapabilities] = useState<Set<string>>(() => new Set(['reasoning']));
  const [body, setBody] = useState(skill.body ?? '');
  const [dirty, setDirty] = useState(false);

  function toggleTrigger(id: string) {
    setTriggers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }

  function toggleCapability(id: string) {
    setCapabilities((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }

  function removeOutput(name: string) {
    setOutputs((prev) => prev.filter((o) => o !== name));
    setDirty(true);
  }

  function discard() {
    setBody(skill.body ?? '');
    setTriggers(new Set(['issue-created']));
    setOutputs(['stdout.json']);
    setCapabilities(new Set(['reasoning']));
    setDirty(false);
  }

  return (
    <div className="flex min-h-[calc(100vh-56px)] flex-col">
      {/* Page header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant bg-surface px-6 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <nav className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Link href="/skills" className="hover:text-on-surface">
              Skills
            </Link>
            <span aria-hidden>›</span>
            <span className="font-medium text-on-surface">{skill.name}</span>
          </nav>
          <span className="hidden h-5 w-px bg-outline-variant sm:inline-block" aria-hidden />
          <div className="inline-flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container-low px-3 py-1.5 font-mono text-[12px] text-on-surface-variant">
            <FileIcon className="h-4 w-4" />
            <span className="text-on-surface">{skill.path || '(no path)'}</span>
          </div>
        </div>
        <span className="inline-flex items-center rounded-md border border-tertiary-container/60 bg-tertiary-container/30 px-2.5 py-1 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-tertiary">
          AI_ASSISTED
        </span>
      </header>

      {/* Two-column body */}
      <div className="flex flex-1 flex-col gap-0 lg:grid lg:grid-cols-[360px_1fr]">
        {/* LEFT: Metadata + capabilities */}
        <aside className="border-b border-outline-variant bg-surface-container-low px-5 py-5 lg:border-b-0 lg:border-r">
          <SectionLabel>Metadata Configuration</SectionLabel>

          <Field label="Skill Name">
            <Input value={skill.name} readOnly />
          </Field>

          <Field label="Execution Mode">
            <Select
              value={executionMode}
              onChange={(v) => {
                setExecutionMode(v);
                setDirty(true);
              }}
              disabled={readOnly}
              options={EXECUTION_MODES}
            />
          </Field>

          <Field label="Trigger Condition">
            <div className="rounded-md border border-outline-variant bg-surface">
              {TRIGGER_CONDITIONS.map((t, i) => (
                <label
                  key={t.id}
                  className={cn(
                    'flex cursor-pointer items-center justify-between px-3 py-2 text-sm text-on-surface',
                    i !== 0 && 'border-t border-outline-variant/60',
                    readOnly && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <span>{t.label}</span>
                  <input
                    type="checkbox"
                    checked={triggers.has(t.id)}
                    onChange={() => toggleTrigger(t.id)}
                    disabled={readOnly}
                    className="h-4 w-4 accent-primary"
                  />
                </label>
              ))}
            </div>
          </Field>

          <Field label="Output Configuration">
            <div className="flex flex-col gap-2">
              {outputs.map((o) => (
                <div
                  key={o}
                  className="flex items-center justify-between rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-on-surface"
                >
                  <span className="inline-flex items-center gap-2 font-mono text-[13px]">
                    <CodeIcon className="h-4 w-4 text-on-surface-variant" />
                    {o}
                  </span>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => removeOutput(o)}
                      className="text-xs text-on-surface-variant hover:text-error"
                      aria-label={`Remove ${o}`}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                disabled={readOnly}
                className="inline-flex items-center gap-2 rounded-md border border-dashed border-outline-variant bg-transparent px-3 py-2 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" />
                Add destination
              </button>
            </div>
          </Field>

          <div className="mt-8">
            <SectionLabel>AI Skill Capabilities</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              {CAPABILITIES.map((cap) => {
                const active = capabilities.has(cap.id);
                return (
                  <button
                    key={cap.id}
                    type="button"
                    onClick={() => toggleCapability(cap.id)}
                    disabled={readOnly}
                    className={cn(
                      'flex flex-col items-center justify-center gap-2 rounded-md border bg-surface px-3 py-4 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                      active
                        ? 'border-primary/60 bg-primary-container/15 text-primary'
                        : 'border-outline-variant text-on-surface-variant hover:border-primary hover:text-on-surface',
                    )}
                  >
                    {cap.icon}
                    <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em]">
                      {cap.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {skill.description && (
            <div className="mt-8">
              <SectionLabel>Description</SectionLabel>
              <p className="text-sm leading-relaxed text-on-surface-variant">{skill.description}</p>
            </div>
          )}

          {skill.stages.length > 0 && (
            <div className="mt-6">
              <SectionLabel>Suggested Stages</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {skill.stages.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center rounded-md border border-outline-variant bg-surface px-2 py-0.5 font-mono text-[11px] text-on-surface-variant"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* RIGHT: Instruction workspace */}
        <section className="flex min-h-[420px] flex-col bg-surface">
          <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-5 py-3">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Instruction Workspace (MD)
            </span>
            <span
              className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[10px] font-semibold uppercase tracking-[0.05em]',
                dirty
                  ? 'border-tertiary/40 bg-tertiary-container/20 text-tertiary'
                  : 'border-outline-variant bg-surface-container text-on-surface-variant',
              )}
            >
              {dirty ? 'Unsaved' : 'Auto-saved'}
            </span>
          </div>
          <div className="flex-1 overflow-hidden bg-surface-container-lowest p-0">
            {skill.body === null ? (
              <div className="flex h-full min-h-[300px] items-center justify-center p-6 text-center text-sm text-on-surface-variant">
                <div>
                  <p>
                    No content cached. Run{' '}
                    <Link href="/skills" className="text-primary hover:underline">
                      Sync from repo
                    </Link>{' '}
                    to load this skill&apos;s markdown.
                  </p>
                </div>
              </div>
            ) : (
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                }}
                readOnly={readOnly}
                spellCheck={false}
                className="block h-full min-h-[420px] w-full resize-none bg-surface-container-lowest p-5 font-mono text-[13px] leading-[20px] text-on-surface focus:outline-none"
              />
            )}
          </div>
        </section>
      </div>

      {/* Dry run preview */}
      <section className="border-t border-outline-variant bg-surface-container-low">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-outline-variant px-6 py-3">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Dry Run Preview
            </span>
            <SelectButton placeholder="Select Test Issue" />
          </div>
          <button
            type="button"
            disabled
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on opacity-60"
            title="Dry-run runner is not implemented yet"
          >
            <PlayIcon className="h-4 w-4" />
            Run Simulation
          </button>
        </div>
        <div className="grid gap-0 md:grid-cols-2">
          <div className="border-b border-outline-variant px-6 py-4 md:border-b-0 md:border-r">
            <div className="mb-2 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Resolved System Prompt
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
              {`"You are an AI assistant specialized in developer workflows.\nAnalyzing issue #1024 context... Apply ${skill.name} logic...\nEnvironment: production-cluster-a..."`}
            </pre>
          </div>
          <div className="px-6 py-4">
            <div className="mb-2 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Simulation Output
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-on-surface-variant">
              <span className="text-primary">[--:--:--]</span> <span className="text-tertiary">INFO</span>: Run simulation to view output.
            </pre>
          </div>
        </div>
      </section>

      {/* Sticky save footer */}
      <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant bg-surface-container-low px-6 py-3">
        <button
          type="button"
          onClick={discard}
          disabled={!dirty || readOnly}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard Changes
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm font-medium text-on-surface transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
            title="Save-as-override is wired in a follow-up"
          >
            <RotateLeftIcon className="h-4 w-4" />
            Save as override
          </button>
          <button
            type="button"
            disabled={readOnly}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
            title="Save & enable is wired in a follow-up"
          >
            <CheckIcon className="h-4 w-4" />
            Save &amp; Enable Skill
          </button>
        </div>
      </footer>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-xs text-on-surface-variant">{label}</div>
      {children}
    </div>
  );
}

function Input({ value, readOnly }: { value: string; readOnly?: boolean }) {
  return (
    <input
      value={value}
      readOnly={readOnly}
      className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface read-only:opacity-80 focus:border-primary focus:outline-none"
    />
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 w-full appearance-none rounded-md border border-outline-variant bg-surface px-3 pr-9 text-sm text-on-surface focus:border-primary focus:outline-none disabled:opacity-60"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-on-surface-variant" />
    </div>
  );
}

function SelectButton({ placeholder }: { placeholder: string }) {
  return (
    <button
      type="button"
      disabled
      className="inline-flex h-9 items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant opacity-80"
    >
      <span>{placeholder}</span>
      <ChevronDownIcon className="h-4 w-4" />
    </button>
  );
}
