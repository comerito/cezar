import type { RecurringQuestionResults } from '@cezar/core';

export function formatRecurringResults(results: RecurringQuestionResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No recurring questions found.');
      return;
    }

    for (const item of results.items) {
      const refs = item.similarClosedIssues.map(i => `#${i.number}`).join(', ');
      console.log(`  #${item.number}: similar to ${refs}`);
      console.log(`    ${item.suggestedResponse.split('\n')[0]}`);
      console.log('');
    }
    console.log(`Found ${results.items.length} recurring question(s).`);
  }
