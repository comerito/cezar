import { actionRegistry } from '../registry.js';
import { MilestonePlanRunner } from './runner.js';
import { MilestonePlanInteractiveUI } from './interactive.js';

actionRegistry.register({
  id: 'milestone-planner',
  label: 'Milestone Planner',
  description: 'Group open issues into logical release milestones',
  icon: '🗺️',
  group: 'release',

  getBadge(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    return `${open.length} open issues`;
  },

  isAvailable(store) {
    const open = store.getIssues({ state: 'open', hasDigest: true });
    if (open.length < 3) return 'need at least 3 open issues for meaningful grouping';
    return true;
  },

  async run({ store, config, interactive }) {
    if (interactive) {
      await new MilestonePlanInteractiveUI(store, config).present();
    } else {
      const runner = new MilestonePlanRunner(store, config);
      const results = await runner.plan();
      results.print();
    }
  },
});
