import { actionRegistry } from '../registry.js';
import { MissingInfoRunner, type MissingInfoOptions } from './runner.js';
import { MissingInfoInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'missing-info',
  label: 'Request Missing Info',
  description: 'Detect bug reports missing critical information and draft follow-up comments',
  icon: '❓',
  group: 'triage',

  getBadge(store) {
    const bugs = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'bug');
    const unchecked = bugs.filter(i => i.analysis.missingInfoAnalyzedAt === null).length;
    const commentUpdated = bugs.filter(i =>
      i.analysis.missingInfoAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.missingInfoAnalyzedAt,
    ).length;
    const total = unchecked + commentUpdated;
    if (total === 0) return 'up to date';
    const parts = [];
    if (unchecked > 0) parts.push(`${unchecked} unchecked`);
    if (commentUpdated > 0) parts.push(`${commentUpdated} updated`);
    return parts.join(', ');
  },

  isAvailable(store) {
    const bugs = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'bug');
    if (bugs.length === 0) return 'no bug reports with digest';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: MissingInfoOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new MissingInfoRunner(store, config);
    const results = await runner.detect(runnerOpts);

    if (interactive) {
      await new MissingInfoInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
