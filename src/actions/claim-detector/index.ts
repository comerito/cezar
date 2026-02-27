import { actionRegistry } from '../registry.js';
import { ClaimDetectorRunner, type ClaimDetectorOptions } from './runner.js';
import { ClaimDetectorInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'claim-detector',
  label: 'Claim Detector',
  description: 'Find issues claimed by contributors in comments',
  icon: '🙋',
  group: 'community',

  getBadge(store) {
    const open = store.getIssues({ state: 'open' });
    const unchecked = open.filter(i => i.analysis.claimDetectedAt === null);
    return unchecked.length > 0 ? `${unchecked.length} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open' });
    if (open.length === 0) return 'no open issues';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: ClaimDetectorOptions = {
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new ClaimDetectorRunner(store, config);
    const results = await runner.detect(runnerOpts);

    if (interactive) {
      await new ClaimDetectorInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
