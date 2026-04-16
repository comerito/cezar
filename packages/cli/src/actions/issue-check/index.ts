import { input } from '@inquirer/prompts';
import { actionRegistry } from '@cezar/core';
import { IssueCheckRunner, type IssueCheckOptions } from '@cezar/core';
import { IssueCheckInteractiveUI } from './interactive.js';
import { formatIssueCheckResults } from '../../formatters/issue-check.js';

actionRegistry.register({
  id: 'issue-check',
  label: 'Check Before Reporting',
  description: 'Check if an issue already exists before creating a new one',
  icon: '🔎',
  group: 'triage',

  getBadge(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length === 0) return 'no open issues';
    return `${open.length} searchable`;
  },

  isAvailable(store) {
    const withDigest = store.getIssues({ state: 'open', hasDigest: true });
    if (withDigest.length === 0) return 'no open issues with digest — run init first';
    return true;
  },

  async run({ store, config, interactive, options }) {
    let description = options.description as string | undefined;

    if (!description) {
      if (!interactive) {
        console.error('--description is required in non-interactive mode');
        process.exit(1);
      }
      description = await input({
        message: 'Describe the issue you want to report:',
        validate: (v) => v.trim().length > 0 || 'Description is required',
      });
    }

    const runnerOpts: IssueCheckOptions = {
      description,
      dryRun: options.dryRun as boolean ?? false,
    };

    const runner = new IssueCheckRunner(store, config);
    const results = await runner.check(runnerOpts);

    if (interactive) {
      await new IssueCheckInteractiveUI(results, config).present();
    } else {
      formatIssueCheckResults(results);
    }
  },
});
