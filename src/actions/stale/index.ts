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
    return stale.length > 0 ? `${stale.length} stale` : 'no stale issues';
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
