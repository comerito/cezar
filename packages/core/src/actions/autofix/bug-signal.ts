import type { StoredIssue } from '../../store/store.model.js';

/**
 * Decision about whether to treat an issue as a bug for autofix purposes.
 *
 * Three signals, in priority order:
 *
 *   1. `analysis.issueType === 'bug'` with `bugConfidence ≥ minConfidence` —
 *      the canonical signal from the bug-detector action.
 *   2. A `bug`-like label (case-insensitive: `bug`, `bug:*`, `kind/bug`,
 *      `type:bug`, etc.) — the human's explicit classification.
 *   3. A `bug`-like title prefix (`bug:`, `[bug]`, `[BUG]`, `bug -`, …) —
 *      author convention.
 *
 * Signals 2 and 3 bypass the bug-detector entirely. They were added because
 * issues synced from GitHub that haven't yet had bug-detector run against
 * them would otherwise skip autofix with "not classified as a bug" even
 * when both label and title scream BUG. See the autofix orchestrator's
 * pre-flight gate in this directory.
 */
export interface BugSignal {
  isBug: boolean;
  /** True when the signal is strong enough to bypass `minBugConfidence`. */
  isHighConfidence: boolean;
  /** Short human-readable explanation of which signal won. */
  reason: string;
}

export interface BugSignalOptions {
  /** Mirrors `autofix.minBugConfidence` — only consulted for the classifier
   *  signal. Label/title signals are treated as fully confident. */
  minConfidence: number;
}

const BUG_LABEL_PATTERN = /^(?:bug|type[:/]bug|kind[:/]bug)\b/i;
// Matches a leading `[bug]` / `[BUG]` bracket tag OR a bare `bug` followed by
// a separator (`bug:`, `bug -`, `bug —`). Bare `bug` without a separator is
// rejected so words like `debugging` or `bug spray` don't accidentally match.
const BUG_TITLE_PATTERN = /^\s*(?:\[bug\]|bug\s*[:\-—–])/i;

export function detectBugSignal(issue: StoredIssue, opts: BugSignalOptions): BugSignal {
  const classifierSaysBug = issue.analysis.issueType === 'bug';
  const classifierConfidence = issue.analysis.bugConfidence ?? 0;

  // Strong-signal fallbacks — checked first so they can override a missing
  // or low-confidence classifier result.
  const matchingLabel = issue.labels.find((l) => BUG_LABEL_PATTERN.test(l));
  if (matchingLabel) {
    return {
      isBug: true,
      isHighConfidence: true,
      reason: `'${matchingLabel}' label`,
    };
  }

  if (BUG_TITLE_PATTERN.test(issue.title)) {
    return {
      isBug: true,
      isHighConfidence: true,
      reason: `'bug:' title prefix`,
    };
  }

  if (classifierSaysBug && classifierConfidence >= opts.minConfidence) {
    return {
      isBug: true,
      isHighConfidence: true,
      reason: `bug-detector confident (${classifierConfidence.toFixed(2)} ≥ ${opts.minConfidence})`,
    };
  }

  if (classifierSaysBug) {
    return {
      isBug: false,
      isHighConfidence: false,
      reason: `bug-detector ran but confidence ${classifierConfidence.toFixed(2)} < threshold ${opts.minConfidence} — no 'bug' label or title prefix to override`,
    };
  }

  if (issue.analysis.issueType !== null) {
    return {
      isBug: false,
      isHighConfidence: false,
      reason: `bug-detector classified as '${issue.analysis.issueType}' — no 'bug' label or title prefix to override`,
    };
  }

  return {
    isBug: false,
    isHighConfidence: false,
    reason: 'not classified as a bug (no bug-detector run, no `bug` label, no `bug:` title prefix)',
  };
}
