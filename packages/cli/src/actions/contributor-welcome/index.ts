import { actionRegistry } from '@cezar/core';
import { ContributorWelcomeRunner, findFirstTimeAuthors, type WelcomeOptions } from '@cezar/core';
import { ContributorWelcomeInteractiveUI } from './interactive.js';
import { formatContributorWelcomeResults } from '../../formatters/contributor-welcome.js';

actionRegistry.register({
  id: 'contributor-welcome',
  label: 'Welcome New Contributors',
  description: 'Post personalized welcome comments to first-time contributors',
  icon: '👋',
  group: 'community',

  getBadge(store) {
    const firstTimers = findFirstTimeAuthors(store);
    const pending = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => firstTimers.has(i.author) && i.analysis.welcomeCommentPostedAt === null);
    return pending.length > 0 ? `${pending.length} pending` : 'up to date';
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: WelcomeOptions = {
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new ContributorWelcomeRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new ContributorWelcomeInteractiveUI(results, config).present();
    } else {
      formatContributorWelcomeResults(results);
    }
  },
});
