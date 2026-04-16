import { actionRegistry } from '../registry.js';
import { AutofixRunner, type AutofixOptions } from './runner.js';
import { AutofixInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'autofix',
  label: 'Autofix Bugs',
  description: 'Spawn an orchestrated coding-agent workflow that analyzes, fixes, reviews, and opens a PR',
  icon: '🔧',
  group: 'intelligence',

  getBadge(store) {
    const cfg = (store as unknown as { config?: { autofix?: { minBugConfidence?: number } } }).config?.autofix;
    const threshold = cfg?.minBugConfidence ?? 0.7;
    const eligible = store.getIssues({ state: 'open' }).filter(i =>
      i.analysis.issueType === 'bug' &&
      (i.analysis.bugConfidence ?? 0) >= threshold &&
      i.analysis.autofixStatus !== 'pr-opened',
    ).length;
    const opened = store.getIssues({ state: 'open' }).filter(i => i.analysis.autofixStatus === 'pr-opened').length;
    if (eligible === 0 && opened === 0) return 'nothing to fix';
    const parts: string[] = [];
    if (eligible > 0) parts.push(`${eligible} eligible`);
    if (opened > 0) parts.push(`${opened} PR(s) open`);
    return parts.join(' · ');
  },

  isAvailable(store) {
    const bugs = store.getIssues({ state: 'open' }).filter(i => i.analysis.issueType === 'bug');
    if (bugs.length === 0) return 'no bug-classified issues — run bug-detector first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: AutofixOptions = {
      apply: options.apply as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      issue: typeof options.issue === 'number' ? options.issue : undefined,
      maxIssues: typeof options.maxIssues === 'number' ? options.maxIssues : undefined,
      retry: options.retry as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    if (interactive) {
      await new AutofixInteractiveUI(store, config).present(runnerOpts);
    } else {
      const results = await new AutofixRunner(store, config).run(runnerOpts);
      results.print();
    }
  },
});
