import { actionRegistry } from '@cezar/core';
import { DoneDetectorRunner, type DoneDetectorOptions } from '@cezar/core';
import { DoneDetectorInteractiveUI } from './interactive.js';
import { formatDoneDetectorResults } from '../../formatters/done-detector.js';

actionRegistry.register({
  id: 'done-detector',
  label: 'Done Detector',
  description: 'Find open issues that were likely resolved by merged PRs',
  icon: '✅',
  group: 'triage',

  getBadge(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    const unchecked = open.filter(i => i.analysis.doneAnalyzedAt === null);
    return unchecked.length > 0 ? `${unchecked.length} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues with digest';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: DoneDetectorOptions = {
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
    };

    const runner = new DoneDetectorRunner(store, config);
    const results = await runner.detect(runnerOpts);

    if (interactive) {
      await new DoneDetectorInteractiveUI(results, config).present();
    } else {
      formatDoneDetectorResults(results);
    }
  },
});
