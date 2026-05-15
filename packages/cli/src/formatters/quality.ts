import type { QualityResults } from '@cezar/core';

export function formatQualityResults(results: QualityResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No quality issues found — all issues look legitimate.');
      return;
    }

    const counts = results.flagCounts;
    console.log(`\nFlagged ${results.flagged.length} issue(s):`);
    for (const [flag, count] of Object.entries(counts)) {
      console.log(`  ${flag}: ${count}`);
    }

    console.log('');
    for (const item of results.flagged) {
      console.log(`  #${item.number} [${item.flag}] ${item.title}`);
      console.log(`    ${item.reason}`);
      console.log('');
    }
  }
