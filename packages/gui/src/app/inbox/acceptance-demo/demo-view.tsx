'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { CheckIcon, SparkleSmallIcon } from '@/components/icons';

// ─────────────────────────────────────────────────────────────────────
// Sample findings to power the live preview.
// Mirrors the shape of what an action produces — a confidence per item.
// ─────────────────────────────────────────────────────────────────────
type SampleFinding = {
  id: string;
  issueNumber: number;
  summary: string;
  confidence: number;
};

const SAMPLE: SampleFinding[] = [
  { id: 's1', issueNumber: 1395, summary: 'Spelling fix in /docs/intro.md', confidence: 100 },
  { id: 's2', issueNumber: 1402, summary: 'Duplicate of #1388', confidence: 94 },
  { id: 's3', issueNumber: 1410, summary: 'Classified as runtime bug', confidence: 91 },
  { id: 's4', issueNumber: 1410, summary: 'Priority P1 (customer-facing)', confidence: 89 },
  { id: 's5', issueNumber: 1402, summary: 'Log pattern AuthTokenExpiring', confidence: 88 },
  { id: 's6', issueNumber: 1421, summary: 'Labels: performance, memory', confidence: 84 },
  { id: 's7', issueNumber: 1438, summary: 'Duplicate of #1290', confidence: 81 },
  { id: 's8', issueNumber: 1410, summary: 'Linked to deployment v2.4.1-rc', confidence: 76 },
  { id: 's9', issueNumber: 1421, summary: 'Priority P2 (degradation over 24h)', confidence: 71 },
  { id: 's10', issueNumber: 1457, summary: 'Possible duplicate of #1102', confidence: 64 },
  { id: 's11', issueNumber: 1460, summary: 'Maybe a feature request, not a bug', confidence: 52 },
  { id: 's12', issueNumber: 1471, summary: 'Could be related to #1290', confidence: 38 },
];

const MODELS = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: 'Best judgment · highest cost' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Balanced default' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Fast & cheap · use for high-volume triage' },
] as const;

type Mode = 'auto' | 'hitl';

export function AcceptanceDemo() {
  const [model, setModel] = useState<(typeof MODELS)[number]['id']>('claude-sonnet-4-6');
  const [mode, setMode] = useState<Mode>('hitl');
  const [autoAccept, setAutoAccept] = useState(92);
  const [denyBelow, setDenyBelow] = useState(60);

  // Keep the two thresholds valid: denyBelow always strictly < autoAccept.
  const handleDenyBelow = (v: number) => {
    setDenyBelow(Math.min(v, autoAccept - 1));
  };
  const handleAutoAccept = (v: number) => {
    setAutoAccept(Math.max(v, denyBelow + 1));
  };

  const buckets = useMemo(() => {
    const accept: SampleFinding[] = [];
    const review: SampleFinding[] = [];
    const deny: SampleFinding[] = [];
    if (mode === 'auto') {
      for (const f of SAMPLE) {
        if (f.confidence >= autoAccept) accept.push(f);
        else deny.push(f);
      }
    } else {
      for (const f of SAMPLE) {
        if (f.confidence >= autoAccept) accept.push(f);
        else if (f.confidence >= denyBelow) review.push(f);
        else deny.push(f);
      }
    }
    return { accept, review, deny };
  }, [mode, autoAccept, denyBelow]);

  return (
    <div className="mx-auto max-w-[1080px] px-8 py-6">
      <header className="mb-6">
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-outline">
          Actions · Bug Detector
        </div>
        <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
          Model &amp; acceptance
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Pick the model this action runs on and how its findings should be accepted.
        </p>
      </header>

      <section className="rounded-lg border border-outline-variant bg-surface-container-low">
        {/* ── MODEL ── */}
        <div className="border-b border-outline-variant/60 px-6 py-5">
          <FieldLabel
            title="Model"
            hint="Larger models reason better but cost more per run. Switching is non-destructive."
          />
          <div className="mt-3 grid grid-cols-3 gap-3">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModel(m.id)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-md border px-3 py-3 text-left transition-colors',
                  model === m.id
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-outline-variant bg-surface-container hover:border-outline',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full border',
                      model === m.id ? 'border-primary bg-primary' : 'border-outline-variant',
                    )}
                  >
                    {model === m.id && (
                      <span className="h-1.5 w-1.5 rounded-full bg-primary-on" />
                    )}
                  </span>
                  <span className="text-sm font-medium text-on-surface">{m.label}</span>
                </div>
                <span className="text-xs text-on-surface-variant">{m.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ── ACCEPTANCE MODE ── */}
        <div className="border-b border-outline-variant/60 px-6 py-5">
          <FieldLabel
            title="Acceptance"
            hint="How findings from this action get applied."
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <ModeCard
              active={mode === 'auto'}
              onClick={() => setMode('auto')}
              title="Auto-accept"
              body="Agent decides 100% based on a single confidence cutoff. Nothing goes to the inbox."
              chip={`${SAMPLE.length} findings → 2 buckets`}
            />
            <ModeCard
              active={mode === 'hitl'}
              onClick={() => setMode('hitl')}
              title="Human-in-the-loop"
              body="Medium-confidence findings land in the inbox for review. High = auto-accept, low = auto-deny."
              chip={`${SAMPLE.length} findings → 3 buckets`}
            />
          </div>
        </div>

        {/* ── THRESHOLDS ── */}
        <div className="px-6 py-5">
          <FieldLabel
            title="Confidence thresholds"
            hint={
              mode === 'auto'
                ? 'Findings at or above the cutoff are accepted; everything else is denied.'
                : 'Drag the handles to set the deny floor and the auto-accept ceiling.'
            }
          />

          <div className="mt-5">
            {mode === 'auto' ? (
              <SingleThreshold value={autoAccept} onChange={setAutoAccept} />
            ) : (
              <DualThreshold
                low={denyBelow}
                high={autoAccept}
                onLow={handleDenyBelow}
                onHigh={handleAutoAccept}
              />
            )}
          </div>

          {/* ── LIVE PREVIEW ── */}
          <div className="mt-6 rounded-md border border-outline-variant/60 bg-surface px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-outline">
                Live preview · {SAMPLE.length} sample findings
              </span>
              <span className="text-[10.5px] text-outline">
                Reflects what would happen to historical output at these thresholds.
              </span>
            </div>

            <div className="space-y-2">
              <BucketRow
                tone="success"
                label={mode === 'auto' ? `Accepted (≥ ${autoAccept}%)` : `Auto-accept (≥ ${autoAccept}%)`}
                items={buckets.accept}
                total={SAMPLE.length}
              />
              {mode === 'hitl' && (
                <BucketRow
                  tone="info"
                  label={`Human review (${denyBelow}% – ${autoAccept - 1}%)`}
                  items={buckets.review}
                  total={SAMPLE.length}
                />
              )}
              <BucketRow
                tone="muted"
                label={
                  mode === 'auto'
                    ? `Denied (< ${autoAccept}%)`
                    : `Auto-deny (< ${denyBelow}%)`
                }
                items={buckets.deny}
                total={SAMPLE.length}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface-variant hover:border-outline hover:text-on-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on hover:bg-primary-container"
        >
          Save acceptance settings
        </button>
      </div>

      <p className="mt-6 text-center text-[11px] text-outline">
        Mockup · backed by the schema delta in the design note · not yet persisted
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────────────────
function FieldLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-on-surface">{title}</div>
      <div className="mt-1 text-xs text-on-surface-variant">{hint}</div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  body,
  chip,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  body: string;
  chip: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group/card flex flex-col gap-2 rounded-md border px-4 py-3 text-left transition-colors',
        active
          ? 'border-primary/60 bg-primary/10'
          : 'border-outline-variant bg-surface-container hover:border-outline',
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-4 w-4 items-center justify-center rounded-full border',
              active ? 'border-primary bg-primary' : 'border-outline-variant',
            )}
          >
            {active && <span className="h-1.5 w-1.5 rounded-full bg-primary-on" />}
          </span>
          <span className="text-sm font-medium text-on-surface">{title}</span>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider',
            active ? 'border-primary/30 bg-primary/10 text-primary' : 'border-outline-variant text-outline',
          )}
        >
          <SparkleSmallIcon className="h-2.5 w-2.5" />
          {chip}
        </span>
      </div>
      <span className="text-xs leading-relaxed text-on-surface-variant">{body}</span>
    </button>
  );
}

// ── single-value threshold (auto mode) ──
function SingleThreshold({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="relative h-8">
        {/* Track background: deny (left) + accept (right) */}
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-surface-container">
          <div
            className="absolute inset-y-0 left-0 bg-outline-variant/50"
            style={{ width: `${value}%` }}
          />
          <div
            className="absolute inset-y-0 bg-emerald-500/40"
            style={{ left: `${value}%`, right: 0 }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Auto-accept threshold"
          className="thresh-slider absolute inset-x-0 top-1/2 z-10 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent"
        />
        <SliderStyles />
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="flex items-center justify-between rounded-md border border-outline-variant/60 bg-surface px-3 py-2">
          <span className="text-on-surface-variant">Cutoff</span>
          <NumberPill value={value} onChange={onChange} />
        </div>
        <div className="flex items-center justify-end gap-1 text-outline">
          <BucketDot tone="success" />
          <span>Auto-accept</span>
          <span className="mx-2">·</span>
          <BucketDot tone="muted" />
          <span>Auto-deny</span>
        </div>
      </div>
    </div>
  );
}

// ── dual-handle range (HITL mode) ──
function DualThreshold({
  low,
  high,
  onLow,
  onHigh,
}: {
  low: number;
  high: number;
  onLow: (v: number) => void;
  onHigh: (v: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="relative h-8">
        {/* Track */}
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-surface-container">
          {/* Deny zone */}
          <div
            className="absolute inset-y-0 left-0 bg-outline-variant/50"
            style={{ width: `${low}%` }}
          />
          {/* Review zone */}
          <div
            className="absolute inset-y-0 bg-primary/40"
            style={{ left: `${low}%`, width: `${high - low}%` }}
          />
          {/* Accept zone */}
          <div
            className="absolute inset-y-0 bg-emerald-500/40"
            style={{ left: `${high}%`, right: 0 }}
          />
        </div>
        {/* Two stacked range inputs — the one on top "wins" when handles meet. */}
        <input
          type="range"
          min={0}
          max={100}
          value={low}
          onChange={(e) => onLow(Number(e.target.value))}
          aria-label="Auto-deny below"
          className="thresh-slider absolute inset-x-0 top-1/2 z-10 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent"
          style={{ pointerEvents: 'none' }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={high}
          onChange={(e) => onHigh(Number(e.target.value))}
          aria-label="Auto-accept above"
          className="thresh-slider absolute inset-x-0 top-1/2 z-20 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent"
          style={{ pointerEvents: 'none' }}
        />
        {/* Re-enable pointer events only on the handle area (browser-default thumbs catch their own clicks). */}
        <DualHandleHack />
        <SliderStyles />
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <ThresholdCell tone="muted" label="Auto-deny below" value={low} onChange={onLow} />
        <div className="flex items-center justify-center text-outline">
          <BucketDot tone="info" />
          <span className="ml-1.5">
            Human review band:{' '}
            <span className="font-mono text-on-surface">
              {low}% – {high - 1}%
            </span>
          </span>
        </div>
        <ThresholdCell tone="success" label="Auto-accept above" value={high} onChange={onHigh} />
      </div>
    </div>
  );
}

function ThresholdCell({
  tone,
  label,
  value,
  onChange,
}: {
  tone: 'muted' | 'success';
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-outline-variant/60 bg-surface px-3 py-2">
      <span className="flex items-center gap-1.5 text-on-surface-variant">
        <BucketDot tone={tone} />
        {label}
      </span>
      <NumberPill value={value} onChange={onChange} />
    </div>
  );
}

function NumberPill({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          onChange(Math.max(0, Math.min(100, n)));
        }}
        className="w-12 rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 text-right font-mono text-xs text-on-surface focus:border-primary focus:outline-none"
      />
      <span className="text-outline">%</span>
    </span>
  );
}

function BucketRow({
  tone,
  label,
  items,
  total,
}: {
  tone: 'success' | 'info' | 'muted';
  label: string;
  items: SampleFinding[];
  total: number;
}) {
  const pct = total === 0 ? 0 : (items.length / total) * 100;
  const barClass = {
    success: 'bg-emerald-500/50',
    info: 'bg-primary/40',
    muted: 'bg-outline-variant/50',
  }[tone];
  const labelClass = {
    success: 'text-emerald-300',
    info: 'text-primary',
    muted: 'text-on-surface-variant',
  }[tone];
  return (
    <div className="grid grid-cols-[200px_1fr_60px] items-center gap-3">
      <div className={cn('flex items-center gap-1.5 text-xs font-medium', labelClass)}>
        <BucketDot tone={tone} />
        {label}
      </div>
      <div className="relative h-6 overflow-hidden rounded-md border border-outline-variant/40 bg-surface-container">
        <div
          className={cn('absolute inset-y-0 left-0 transition-all duration-200', barClass)}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-0 flex items-center gap-1 overflow-hidden px-2">
          {items.slice(0, 6).map((it) => (
            <span
              key={it.id}
              className="truncate rounded bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant"
              title={`#${it.issueNumber} · ${it.summary} (${it.confidence}%)`}
            >
              #{it.issueNumber} · {it.confidence}%
            </span>
          ))}
          {items.length > 6 && (
            <span className="rounded bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-outline">
              +{items.length - 6}
            </span>
          )}
        </div>
      </div>
      <div className="text-right font-mono text-xs text-on-surface">
        {items.length}
        <span className="text-outline">/{total}</span>
      </div>
    </div>
  );
}

function BucketDot({ tone }: { tone: 'success' | 'info' | 'muted' }) {
  const cls = {
    success: 'bg-emerald-400',
    info: 'bg-primary',
    muted: 'bg-outline-variant',
  }[tone];
  return <span className={cn('inline-block h-2 w-2 rounded-full', cls)} />;
}

// Re-enables pointer-events on the slider thumbs only so both handles
// stay interactive even though the inputs are stacked.
function DualHandleHack() {
  return (
    <style jsx>{`
      :global(.thresh-slider) {
        pointer-events: none;
      }
      :global(.thresh-slider::-webkit-slider-thumb) {
        pointer-events: auto;
      }
      :global(.thresh-slider::-moz-range-thumb) {
        pointer-events: auto;
      }
    `}</style>
  );
}

function SliderStyles() {
  return (
    <style jsx>{`
      :global(.thresh-slider) {
        -webkit-appearance: none;
        appearance: none;
        outline: none;
      }
      :global(.thresh-slider::-webkit-slider-runnable-track) {
        background: transparent;
        height: 8px;
      }
      :global(.thresh-slider::-moz-range-track) {
        background: transparent;
        height: 8px;
      }
      :global(.thresh-slider::-webkit-slider-thumb) {
        -webkit-appearance: none;
        appearance: none;
        height: 18px;
        width: 18px;
        border-radius: 9999px;
        background: #adc6ff;
        border: 3px solid #10131a;
        box-shadow:
          0 0 0 1px #adc6ff,
          0 2px 6px rgba(0, 0, 0, 0.5);
        cursor: grab;
        margin-top: -5px;
      }
      :global(.thresh-slider::-webkit-slider-thumb:active) {
        cursor: grabbing;
      }
      :global(.thresh-slider::-moz-range-thumb) {
        height: 18px;
        width: 18px;
        border-radius: 9999px;
        background: #adc6ff;
        border: 3px solid #10131a;
        box-shadow:
          0 0 0 1px #adc6ff,
          0 2px 6px rgba(0, 0, 0, 0.5);
        cursor: grab;
      }
    `}</style>
  );
}
