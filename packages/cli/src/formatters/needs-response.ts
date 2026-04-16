import type { NeedsResponseResults } from '@cezar/core';

export function formatNeedsResponseResults(results: NeedsResponseResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No issues needing response found.');
      return;
    }

    const awaiting = results.needsResponse;
    const responded = results.items.filter(i => i.status === 'responded');

    console.log(`\nNeeds response: ${awaiting.length} issue(s) awaiting maintainer response`);
    if (responded.length > 0) {
      console.log(`Already responded: ${responded.length} issue(s)`);
    }
    console.log('');

    for (const item of awaiting) {
      const tag = item.status === 'new-issue' ? '[NEW]' : '[AWAITING]';
      console.log(`  ${tag} #${item.number}: ${item.title}`);
      console.log(`    ${item.reason}`);
      console.log('');
    }
  }
