import type { MilestonePlanResults } from '@cezar/core';

export function formatMilestoneResults(results: MilestonePlanResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No milestone plan generated.');
      return;
    }

    for (const [i, ms] of results.milestones.entries()) {
      console.log(`\nMILESTONE ${i + 1}: ${ms.name}`);
      console.log(`  Theme: ${ms.theme}`);
      console.log(`  Effort: ${ms.effort}`);
      for (const issue of ms.issues) {
        const p = issue.priority ? `${issue.priority.padEnd(9)} ` : '';
        console.log(`    #${issue.number} ${p}${issue.title}`);
      }
    }

    if (results.unassigned.length > 0) {
      console.log(`\nUNASSIGNED (${results.unassigned.length} issues)`);
      for (const issue of results.unassigned) {
        console.log(`    #${issue.number} ${issue.title}`);
      }
    }
  }
