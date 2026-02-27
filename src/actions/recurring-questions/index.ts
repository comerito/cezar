import { actionRegistry } from '../registry.js';
import { RecurringQuestionRunner, type RecurringQuestionOptions } from './runner.js';
import { RecurringQuestionInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'recurring-questions',
  label: 'Recurring Questions',
  description: 'Find questions already answered in closed issues',
  icon: '🔁',
  group: 'triage',

  getBadge(store) {
    const unchecked = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'question' && i.analysis.recurringAnalyzedAt === null).length;
    return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
  },

  isAvailable(store) {
    const questions = store.getIssues({ state: 'open', hasDigest: true })
      .filter(i => i.digest?.category === 'question');
    if (questions.length === 0) return 'no open questions found';
    const closedIssues = store.getIssues({ state: 'closed', hasDigest: true });
    if (closedIssues.length === 0) return 'no closed issues to compare against';
    return true;
  },

  async run({ store, config, interactive, options }) {
    const runnerOpts: RecurringQuestionOptions = {
      state: (options.state as string as 'open' | 'closed' | 'all') ?? 'open',
      recheck: options.recheck as boolean ?? false,
      dryRun: options.dryRun as boolean ?? false,
      excludeIssues: options.excludeIssues as Set<number> | undefined,
    };

    const runner = new RecurringQuestionRunner(store, config);
    const results = await runner.detect(runnerOpts);

    if (interactive) {
      await new RecurringQuestionInteractiveUI(results, config).present();
    } else {
      results.print();
    }
  },
});
