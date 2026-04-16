import type { IssueCheckResults } from '@cezar/core';

export function formatIssueCheckResults(results: IssueCheckResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No matching issues found.');
      return;
    }

    for (const match of results.matches) {
      console.log(`  #${match.issue.number} (${Math.round(match.confidence * 100)}%) — ${match.issue.title}`);
      console.log(`    ${match.reason}`);
      console.log('');
    }
    console.log(`Found ${results.matches.length} potential match(es).`);
  }
