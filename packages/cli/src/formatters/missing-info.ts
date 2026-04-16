import type { MissingInfoResults } from '@cezar/core';

export function formatMissingInfoResults(results: MissingInfoResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No issues with missing information found.');
      return;
    }

    for (const item of results.items) {
      console.log(`  #${item.number}: missing ${item.missingFields.join(', ')}`);
    }
    console.log(`\nFound ${results.items.length} issue(s) with missing information.`);
  }
