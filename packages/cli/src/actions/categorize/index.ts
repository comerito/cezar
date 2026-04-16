import { actionRegistry } from '../registry.js';
import { CategorizeRunner, type CategorizeOptions } from './runner.js';
import { CategorizeInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'categorize',
  label: 'Categorize Features',
  description: 'Classify issues as framework, domain, or integration',
  icon: '📦',
  group: 'intelligence',

  getBadge(store) {
    const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.featureCategoryAnalyzedAt === null).length;
    return unanalyzed > 0 ? `${unanalyzed} uncategorized` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: CategorizeOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new CategorizeRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new CategorizeInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
