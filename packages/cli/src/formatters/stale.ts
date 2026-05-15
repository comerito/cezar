import type { StaleResults } from '@cezar/core';

const ACTION_ORDER = ['close-resolved', 'close-wontfix', 'label-stale', 'keep-open'] as const;

export function formatStaleResults(results: StaleResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No stale issues found.');
      return;
    }

    const counts = results.actionCounts;
    console.log(`\nStale issues: ${results.items.length}`);
    for (const action of ACTION_ORDER) {
      if (counts[action]) {
        console.log(`  ${action}: ${counts[action]}`);
      }
    }

    console.log('');
    for (const item of results.items) {
      console.log(`  #${item.number} [${item.action}] ${item.title} (${item.daysSinceUpdate}d inactive)`);
      console.log(`    ${item.reason}`);
      console.log('');
    }
  }
