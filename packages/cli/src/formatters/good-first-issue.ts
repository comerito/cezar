import type { GoodFirstIssueResults } from '@cezar/core';

export function formatGoodFirstIssueResults(results: GoodFirstIssueResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No good first issue candidates found.');
      return;
    }

    for (const s of results.suggestions) {
      console.log(`  #${s.number} [${s.estimatedComplexity}]: ${s.reason}`);
      console.log(`    Hint: ${s.codeHint}`);
      console.log('');
    }
    console.log(`Found ${results.suggestions.length} good first issue candidate(s).`);
  }
