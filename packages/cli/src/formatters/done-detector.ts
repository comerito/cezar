import type { DoneDetectorResults } from '@cezar/core';

export function formatDoneDetectorResults(results: DoneDetectorResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }

    if (results.isEmpty) {
      console.log('No issues with merged PR references found.');
      return;
    }

    const done = results.resolved;
    const notDone = results.items.filter(i => !i.isDone);

    console.log(`\nDone detector: ${results.items.length} issue(s) checked`);
    console.log(`  Likely resolved: ${done.length}`);
    console.log(`  Not resolved:    ${notDone.length}`);
    console.log('');

    for (const item of done) {
      const prs = item.mergedPRs.map(pr => `#${pr.prNumber}`).join(', ');
      console.log(`  #${item.number} [${(item.confidence * 100).toFixed(0)}%] ${item.title}`);
      console.log(`    PRs: ${prs} — ${item.reason}`);
      console.log('');
    }
  }
