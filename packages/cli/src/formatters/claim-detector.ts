import type { ClaimDetectorResults } from '@cezar/core';

export function formatClaimDetectorResults(results: ClaimDetectorResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No claim comments detected.');
      return;
    }

    console.log(`\nClaim detector: ${results.items.length} issue(s) with claims`);
    console.log('');

    for (const item of results.items) {
      console.log(`  #${item.number}  ${item.title}`);
      console.log(`    Claimant: @${item.claimant} — "${item.snippet}"`);
      console.log('');
    }
  }
