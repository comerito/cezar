import type { DuplicateResults } from '@cezar/core';

export function formatDuplicateResults(results: DuplicateResults, format: string = 'table'): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No duplicates found.');
      return;
    }

    if (format === 'json') {
      console.log(JSON.stringify(results.groups.map(g => ({
        duplicate: g.duplicate.number,
        original: g.original.number,
        confidence: g.confidence,
        reason: g.reason,
      })), null, 2));
      return;
    }

    // Default: table format
    for (const group of results.groups) {
      console.log(`  #${group.duplicate.number} → duplicate of #${group.original.number} (${Math.round(group.confidence * 100)}%)`);
      console.log(`    ${group.reason}`);
      console.log('');
    }
    console.log(`Found ${results.groups.length} duplicate(s).`);
  }
