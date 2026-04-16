import { actionRegistry } from '../registry.js';
import { GoodFirstIssueRunner, type GoodFirstIssueOptions } from './runner.js';
import { GoodFirstIssueInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'good-first-issue',
  label: 'Good First Issues',
  description: 'Tag issues suitable for new contributors',
  icon: '🌱',
  group: 'community',

  getBadge(store) {
    const unchecked = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => !i.labels.includes('good first issue') && i.analysis.goodFirstIssueAnalyzedAt === null).length;
    return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: GoodFirstIssueOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new GoodFirstIssueRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new GoodFirstIssueInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
