import type { WelcomeResults } from '@cezar/core';

export function formatContributorWelcomeResults(results: WelcomeResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No first-time contributors to welcome.');
      return;
    }

    for (const c of results.candidates) {
      console.log(`  #${c.number} @${c.author} [${c.category}]: ${c.title}`);
      console.log(`    ${c.welcomeMessage.split('\n')[0]}...`);
      console.log('');
    }
    console.log(`Found ${results.candidates.length} first-time contributor(s) to welcome.`);
  }
