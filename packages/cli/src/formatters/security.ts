import type { SecurityResults } from '@cezar/core';

export function formatSecurityResults(results: SecurityResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No security findings.');
      return;
    }

    for (const f of results.findings) {
      console.log(`  #${f.number} [${f.severity}] ${f.category} (${Math.round(f.confidence * 100)}%)`);
      console.log(`    ${f.explanation}`);
      console.log('');
    }
    console.log(`Found ${results.findings.length} potential security issue(s).`);
  }
