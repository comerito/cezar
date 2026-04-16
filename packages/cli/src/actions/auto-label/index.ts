import { actionRegistry } from '@cezar/core';
import { AutoLabelRunner, type LabelOptions } from '@cezar/core';
import { AutoLabelInteractiveUI } from './interactive.js';
import { formatLabelResults } from '../../formatters/auto-label.js';

actionRegistry.register({
  id: 'auto-label',
  label: 'Auto-Label Issues',
  description: 'Suggest and apply labels based on issue content',
  icon: '🏷️',
  group: 'triage',

  getBadge(store) {
    const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.labelsAnalyzedAt === null).length;
    return unanalyzed > 0 ? `${unanalyzed} unlabeled` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: LabelOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new AutoLabelRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new AutoLabelInteractiveUI(results, config).present();
    } else {
      formatLabelResults(results);
    }
  },
});
