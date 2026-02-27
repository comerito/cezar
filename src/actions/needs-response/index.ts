import { actionRegistry } from '../registry.js';
import { NeedsResponseRunner, type NeedsResponseOptions } from './runner.js';
import { NeedsResponseInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'needs-response',
  label: 'Needs Response',
  description: 'Find issues awaiting maintainer response',
  icon: '💬',
  group: 'community',

  getBadge(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    const unanalyzed = open.filter(i => i.analysis.needsResponseAnalyzedAt === null);
    const commentUpdated = open.filter(i =>
      i.analysis.needsResponseAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.needsResponseAnalyzedAt,
    );
    const pending = unanalyzed.length + commentUpdated.length;
    if (open.length === 0) return 'no open issues';
    if (pending === 0) return `${open.length} issues (all analyzed)`;
    const parts = [];
    if (unanalyzed.length > 0) parts.push(`${unanalyzed.length} unanalyzed`);
    if (commentUpdated.length > 0) parts.push(`${commentUpdated.length} updated`);
    return parts.join(', ');
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues with digest';
    const meta = store.getMeta();
    if (!meta.orgMembers || meta.orgMembers.length === 0) {
      return 'no org members found — run init or sync first';
    }
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: NeedsResponseOptions = {
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new NeedsResponseRunner(store, config);
    const results = await runner.analyze(runnerOpts);

    if (interactive) {
      await new NeedsResponseInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
