import { actionRegistry } from '../registry.js';
import { QualityRunner, type QualityOptions } from './runner.js';
import { QualityInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'quality',
  label: 'Issue Quality Check',
  description: 'Flag spam, vague, and low-quality submissions',
  icon: '🔎',
  group: 'community',

  getBadge(store) {
    const unchecked = store.getIssues({ state: 'open' })
      .filter(i => i.analysis.qualityAnalyzedAt === null).length;
    return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open' });
    if (open.length === 0) return 'no open issues';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: QualityOptions = {
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new QualityRunner(store, config);
    const results = await runner.check(runnerOpts);

    if (interactive) {
      await new QualityInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
