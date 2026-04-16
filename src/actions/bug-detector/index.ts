import { actionRegistry } from '../registry.js';
import { BugDetectorRunner, type BugDetectorOptions } from './runner.js';
import { BugDetectorInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'bug-detector',
  label: 'Detect Bugs',
  description: 'Classify issues as bug/feature/question/other',
  icon: '🐛',
  group: 'intelligence',

  getBadge(store) {
    const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.bugAnalyzedAt === null).length;
    if (unanalyzed > 0) return `${unanalyzed} unclassified`;
    const bugs = store.getIssues({ state: 'open' })
      .filter(i => i.analysis.issueType === 'bug').length;
    return `${bugs} bugs detected`;
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: BugDetectorOptions = {
      state: (options.state as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new BugDetectorRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new BugDetectorInteractiveUI(results).present();
    } else {
      results.print();
    }
  },
});
