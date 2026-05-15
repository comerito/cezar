import type { PriorityResults } from '@cezar/core';

export function formatPriorityResults(results: PriorityResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No issues to prioritize.');
      return;
    }

    for (const item of results.items) {
      console.log(`  [${item.priority}] #${item.number}: ${item.reason}`);
      console.log(`    Signals: ${item.signals.join(', ')}`);
      console.log('');
    }
    console.log(`Prioritized ${results.items.length} issue(s).`);
  }
