import { actionRegistry } from '../registry.js';
import { ReleaseNotesInteractiveUI } from './interactive.js';
import { ReleaseNotesRunner } from './runner.js';

actionRegistry.register({
  id: 'release-notes',
  label: 'Release Notes',
  description: 'Generate structured release notes from closed issues',
  icon: '📋',
  group: 'release',

  getBadge(store) {
    const closed = store.getIssues({ state: 'closed', hasDigest: true });
    return closed.length > 0 ? `${closed.length} closed issues` : 'no closed issues';
  },

  isAvailable(store) {
    const closed = store.getIssues({ state: 'closed', hasDigest: true });
    if (closed.length === 0) return 'no closed issues with digest — sync with --include-closed';
    return true;
  },

  async run({ store, config, interactive }) {
    if (interactive) {
      await new ReleaseNotesInteractiveUI(store, config).present();
    } else {
      const runner = new ReleaseNotesRunner(store, config);
      const result = await runner.generate();
      result.print();
    }
  },
});
