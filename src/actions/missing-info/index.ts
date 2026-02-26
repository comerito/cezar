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
      .filter(i => i.digest?.category === 'bug' && i.analysis.missingInfoAnalyzedAt === null);
    return bugs.length > 0 ? `${bugs.length} unchecked bugs` : 'up to date';
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
