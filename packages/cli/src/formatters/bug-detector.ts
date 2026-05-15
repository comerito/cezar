import type { BugDetectorResults } from '@cezar/core';

export function formatBugDetectorResults(results: BugDetectorResults): void {
    if (results.message) {
      console.log(results.message);
      return;
    }
    if (results.isEmpty) {
      console.log('No issues classified.');
      return;
    }

    const byType = {
      bug: results.classifications.filter(c => c.issueType === 'bug').length,
      feature: results.classifications.filter(c => c.issueType === 'feature').length,
      question: results.classifications.filter(c => c.issueType === 'question').length,
      other: results.classifications.filter(c => c.issueType === 'other').length,
    };

    console.log(`Classified ${results.classifications.length} issue(s):`);
    console.log(`  🐛 bug:      ${byType.bug}`);
    console.log(`  ✨ feature:  ${byType.feature}`);
    console.log(`  ❓ question: ${byType.question}`);
    console.log(`  📦 other:    ${byType.other}`);
  }
