import { actionRegistry } from '../registry.js';
import { PriorityRunner, type PriorityOptions } from './runner.js';
import { PriorityInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'priority',
  label: 'Priority Score',
  description: 'Assign priority levels to open issues based on impact signals',
  icon: '📊',
  group: 'intelligence',

  getBadge(store) {
    const unscored = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.priorityAnalyzedAt === null).length;
    return unscored > 0 ? `${unscored} unscored` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: PriorityOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
    };

    const runner = new PriorityRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new PriorityInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
