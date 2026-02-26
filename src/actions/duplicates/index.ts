import { actionRegistry } from '../registry.js';
import { DuplicatesRunner, type DuplicateOptions } from './runner.js';
import { DuplicatesInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'duplicates',
  label: 'Find Duplicates',
  description: 'Detect issues describing the same problem using AI',
  icon: '🔍',

  getBadge(store) {
    const issues = store.getIssues({ state: 'open', hasDigest: true });
    const unanalyzed = issues.filter(i => i.analysis.duplicatesAnalyzedAt === null).length;
    return unanalyzed > 0 ? `${unanalyzed} unanalyzed` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: DuplicateOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      format: options.format as string ?? 'table',
    };

    const runner = new DuplicatesRunner(store, config);
    const results = await runner.detect(runnerOpts);

    if (interactive) {
      await new DuplicatesInteractiveUI(results, config).present();
    } else {
      results.print(runnerOpts.format);
    }
  },
});
