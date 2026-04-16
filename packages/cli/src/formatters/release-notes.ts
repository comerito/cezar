import type { ReleaseNotesResult } from '@cezar/core';

export function formatReleaseNotesResult(results: ReleaseNotesResult): void {
    if (results.message) {
      console.log(results.message);
      return;
    }
    console.log(results.markdown);
  }
