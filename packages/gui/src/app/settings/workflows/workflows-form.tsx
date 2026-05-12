'use client';

import { useActionState, useState, useTransition } from 'react';
import { saveWorkflowBindings, type SaveWorkflowState } from './workflows-actions';
import { refreshRepoSkills } from './skills-action';

export interface SkillMeta {
  name: string;
  description: string | null;
  suggestedStages: string[];
  path: string;
}

export interface BindingRow {
  stepId: string;
  skillName: string | null;
  backend: string | null;
  model: string | null;
  extraTools: string[];
}

interface WorkflowsFormProps {
  autofixStepIds: readonly string[];
  triageStepIds: readonly string[];
  skills: SkillMeta[];
  bindings: BindingRow[];
  commitSha: string | null;
  fetchedAt: string | null;
  readOnly: boolean;
}

// Friendly labels for the bindable step ids.
const STEP_LABELS: Record<string, string> = {
  // Autofix pipeline steps (AUTOFIX_STEP_IDS).
  'verify-in-repo': 'Verify in repo (already-fixed / real-defect preflight)',
  'root-cause': 'Root-cause analysis',
  fix: 'Implement fix',
  review: 'Review the fix',
  // Built-in triage steps (BUILTIN_TRIAGE_STEP_IDS).
  'bug-detector': 'Bug detector',
  priority: 'Priority',
  categorize: 'Categorize',
  security: 'Security',
  quality: 'Quality',
  'good-first-issue': 'Good first issue',
  'missing-info': 'Missing info',
  'needs-response': 'Needs response',
  'claim-detector': 'Claim detector',
  'contributor-welcome': 'Contributor welcome',
  'recurring-questions': 'Recurring questions',
  'release-notes': 'Release notes',
  'milestone-planner': 'Milestone planner',
  duplicates: 'Duplicates',
  stale: 'Stale issues',
  'done-detector': 'Done detector',
  'auto-label': 'Auto-label',
};

// Curated, backend-agnostic model list + a "custom" escape hatch.
const MODEL_CHOICES = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-sonnet-4-20250514',
  'claude-haiku-4-5-20251001',
];

function label(stepId: string): string {
  return STEP_LABELS[stepId] ?? stepId;
}

export function WorkflowsForm({
  autofixStepIds,
  triageStepIds,
  skills,
  bindings,
  commitSha,
  fetchedAt,
  readOnly,
}: WorkflowsFormProps) {
  const [state, formAction, pending] = useActionState<SaveWorkflowState, FormData>(
    saveWorkflowBindings,
    {},
  );
  const [refreshState, setRefreshState] = useState<{ ok?: boolean; error?: string; count?: number } | null>(null);
  const [refreshing, startRefresh] = useTransition();

  const bindingMap = new Map(bindings.map((b) => [b.stepId, b]));

  function handleRefresh() {
    setRefreshState(null);
    startRefresh(async () => {
      const result = await refreshRepoSkills();
      setRefreshState(result);
    });
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* Skill catalog status + refresh */}
      <div className="rounded-lg border border-border bg-bg-elevated p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-fg-muted">
            {skills.length === 0 ? (
              <span>
                No skills found in <code className="text-fg">.ai/skills/</code> — every step uses its
                built-in default. Add <code className="text-fg">.ai/skills/*.md</code> to your repo and refresh.
              </span>
            ) : (
              <span>
                {skills.length} skill{skills.length === 1 ? '' : 's'} discovered
                {commitSha && <> at <code className="text-fg">{commitSha.slice(0, 7)}</code></>}
                {fetchedAt && <> · last refreshed {new Date(fetchedAt).toLocaleString()}</>}
              </span>
            )}
          </div>
          {!readOnly && (
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-fg hover:border-accent disabled:opacity-50"
            >
              {refreshing ? 'Refreshing…' : 'Refresh skills from repo'}
            </button>
          )}
        </div>
        {refreshState?.ok && (
          <p className="mt-2 text-xs text-accent">Found {refreshState.count ?? 0} skill(s). Reload to see them in the dropdowns.</p>
        )}
        {refreshState?.error && <p className="mt-2 text-xs text-danger">{refreshState.error}</p>}
        {skills.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs text-fg-subtle">
            {skills.map((s) => (
              <li key={s.name}>
                <span className="font-mono text-fg">{s.name}</span>
                {s.suggestedStages.length > 0 && <> — suggested for: {s.suggestedStages.join(', ')}</>}
                {s.description && <> — {s.description}</>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form action={formAction} className="space-y-10">
        {state.ok && (
          <div className="rounded-md border border-accent/30 bg-accent/10 px-4 py-2 text-sm text-accent">
            Workflow bindings saved.
          </div>
        )}
        {state.error && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-4 py-2 text-sm text-danger">
            {state.error}
          </div>
        )}

        <StepGroup
          title="Autofix pipeline"
          note='claude-cli / codex-cli backends take effect once self-hosted runners ship (Phase 4).'
          stepIds={autofixStepIds}
          skills={skills}
          bindingMap={bindingMap}
          readOnly={readOnly}
        />

        <StepGroup
          title="Triage steps"
          note="Built-in triage actions. Bind a repo skill to augment a step's prompt (the built-in step always runs)."
          stepIds={triageStepIds}
          skills={skills}
          bindingMap={bindingMap}
          readOnly={readOnly}
        />

        {!readOnly && (
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Save workflow bindings'}
          </button>
        )}
      </form>
    </div>
  );
}

function StepGroup({
  title,
  note,
  stepIds,
  skills,
  bindingMap,
  readOnly,
}: {
  title: string;
  note: string;
  stepIds: readonly string[];
  skills: SkillMeta[];
  bindingMap: Map<string, BindingRow>;
  readOnly: boolean;
}) {
  return (
    <fieldset className="space-y-4">
      <legend className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{title}</legend>
      <p className="text-xs text-fg-subtle">{note}</p>
      <div className="space-y-6">
        {stepIds.map((stepId) => (
          <StepRow
            key={stepId}
            stepId={stepId}
            skills={skills}
            binding={bindingMap.get(stepId)}
            readOnly={readOnly}
          />
        ))}
      </div>
    </fieldset>
  );
}

function StepRow({
  stepId,
  skills,
  binding,
  readOnly,
}: {
  stepId: string;
  skills: SkillMeta[];
  binding: BindingRow | undefined;
  readOnly: boolean;
}) {
  const suggested = skills.filter((s) => s.suggestedStages.includes(stepId));
  const others = skills.filter((s) => !s.suggestedStages.includes(stepId));

  const currentModel = binding?.model ?? '';
  const isCustomModel = currentModel !== '' && !MODEL_CHOICES.includes(currentModel);
  const [modelSelect, setModelSelect] = useState(isCustomModel ? 'custom' : currentModel);

  const inputCls =
    'w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg disabled:opacity-60 read-only:opacity-60 focus:border-accent focus:outline-none';

  return (
    <div className="rounded-lg border border-border bg-bg-elevated p-4">
      <div className="mb-3 text-sm font-medium text-fg">
        {label(stepId)} <span className="font-mono text-xs text-fg-subtle">({stepId})</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {/* Skill */}
        <div>
          <label htmlFor={`skill.${stepId}`} className="mb-1 block text-xs text-fg-muted">Skill</label>
          <select
            id={`skill.${stepId}`}
            name={`skill.${stepId}`}
            defaultValue={binding?.skillName ?? ''}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(built-in default)</option>
            {suggested.length > 0 && (
              <optgroup label="Suggested for this step">
                {suggested.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Other repo skills">
                {others.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Backend */}
        <div>
          <label htmlFor={`backend.${stepId}`} className="mb-1 block text-xs text-fg-muted">Backend</label>
          <select
            id={`backend.${stepId}`}
            name={`backend.${stepId}`}
            defaultValue={binding?.backend ?? ''}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(default)</option>
            <option value="anthropic-api">anthropic-api</option>
            <option value="claude-cli">claude-cli</option>
            <option value="codex-cli">codex-cli</option>
          </select>
        </div>

        {/* Model */}
        <div>
          <label htmlFor={`model.${stepId}`} className="mb-1 block text-xs text-fg-muted">Model</label>
          <select
            id={`model.${stepId}`}
            name={`model.${stepId}`}
            value={modelSelect}
            onChange={(e) => setModelSelect(e.target.value)}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(default)</option>
            {MODEL_CHOICES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {modelSelect === 'custom' && (
            <input
              type="text"
              name={`modelCustom.${stepId}`}
              defaultValue={isCustomModel ? currentModel : ''}
              placeholder="model name"
              readOnly={readOnly}
              className={`mt-2 ${inputCls}`}
            />
          )}
        </div>

        {/* Extra tools */}
        <div>
          <label htmlFor={`tools.${stepId}`} className="mb-1 block text-xs text-fg-muted">
            Extra tools (comma-separated)
          </label>
          <input
            id={`tools.${stepId}`}
            name={`tools.${stepId}`}
            type="text"
            defaultValue={binding?.extraTools.join(', ') ?? ''}
            placeholder="WebSearch, Bash(npm run e2e)"
            readOnly={readOnly}
            className={inputCls}
          />
        </div>
      </div>
    </div>
  );
}
