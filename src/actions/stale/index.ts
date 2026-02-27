import { actionRegistry } from '../registry.js';
import { StaleRunner, type StaleOptions } from './runner.js';
import { StaleInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'stale',
  label: 'Stale Issue Cleanup',
  description: 'Review and resolve issues with no recent activity',
  icon: '🧹',
  group: 'triage',

  getBadge(store) {
    const now = Date.now();
    const threshold = 90; // default; actual config not available here
    const stale = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => (now - new Date(i.updatedAt).getTime()) / 86400000 >= threshold);
    const unanalyzed = stale.filter(i => i.analysis.staleAnalyzedAt === null).length;
    const commentUpdated = stale.filter(i =>
      i.analysis.staleAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.staleAnalyzedAt,
    ).length;
    const pending = unanalyzed + commentUpdated;
    if (stale.length === 0) return 'no stale issues';
    if (pending === 0) return `${stale.length} stale (all analyzed)`;
    const parts = [];
    if (unanalyzed > 0) parts.push(`${unanalyzed} unanalyzed`);
    if (commentUpdated > 0) parts.push(`${commentUpdated} updated`);
    return parts.join(', ');
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues with digest';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: StaleOptions = {
      daysThreshold: config.sync.staleDaysThreshold,
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new StaleRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new StaleInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
