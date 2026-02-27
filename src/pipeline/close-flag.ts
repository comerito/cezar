import type { StoredIssue } from '../store/store.model.js';
import type { IssueStore } from '../store/store.js';

/**
 * Returns true if the issue has been flagged for closing by a Phase 1 action
 * (duplicate detection or done-detector).
 */
export function isCloseFlagged(issue: StoredIssue): boolean {
  return issue.analysis.duplicateOf !== null || issue.analysis.doneDetected === true;
}

/**
 * Returns a set of open issue numbers that are close-flagged.
 */
export function getCloseFlaggedIssueNumbers(store: IssueStore): Set<number> {
  const openIssues = store.getIssues({ state: 'open' });
  const flagged = new Set<number>();
  for (const issue of openIssues) {
    if (isCloseFlagged(issue)) {
      flagged.add(issue.number);
    }
  }
  return flagged;
}

/**
 * Filters out close-flagged issues from a candidate list.
 * Reads `excludeIssues` from options; no-op if absent.
 */
export function applyPipelineExclusions<T extends { number: number }>(
  candidates: T[],
  options: { excludeIssues?: Set<number> },
): T[] {
  const { excludeIssues } = options;
  if (!excludeIssues || excludeIssues.size === 0) return candidates;
  return candidates.filter(c => !excludeIssues.has(c.number));
}
