import type { CategorizeResults } from '@cezar/core';

export function formatCategorizeResults(results: CategorizeResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No categorization suggestions found.');
      return;
    }

    for (const s of results.suggestions) {
      console.log(`  #${s.number}: ${s.category}`);
      console.log(`    ${s.reason}`);
      console.log('');
    }
    console.log(`Categorized ${results.suggestions.length} issue(s).`);
  }
