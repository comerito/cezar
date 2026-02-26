import { actionRegistry } from '../registry.js';
import { SecurityRunner, type SecurityOptions } from './runner.js';
import { SecurityInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'security',
  label: 'Security Triage',
  description: 'Scan all issues for potential security implications',
  icon: '🔒',
  group: 'intelligence',

  getBadge(store) {
    const unscanned = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.analysis.securityAnalyzedAt === null).length;
    return unscanned > 0 ? `${unscanned} unscanned` : 'up to date';
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ hasDigest: true });
    if (withDigest.length === 0) return 'no issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: SecurityOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
    };

    const runner = new SecurityRunner(store, config);
    const results = await runner.scan(runnerOpts);

    if (interactive) {
      await new SecurityInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
