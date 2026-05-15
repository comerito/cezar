import type { LabelResults } from '@cezar/core';

export function formatLabelResults(results: LabelResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No label suggestions found.');
      return;
    }

    for (const s of results.suggestions) {
      const current = s.currentLabels.length > 0 ? s.currentLabels.join(', ') : '(none)';
      console.log(`  #${s.number}: ${current} → +${s.suggestedLabels.join(', +')}`);
      console.log(`    ${s.reason}`);
      console.log('');
    }
    console.log(`Found ${results.suggestions.length} issue(s) needing labels.`);
  }
