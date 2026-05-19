/**
 * One-off diagnostic: pull issue #N from GitHub directly and run
 * detectBugSignal against it to see what the autofix gate would decide.
 *
 *   npx tsx packages/core/scripts/diag-bug-signal.ts \
 *     <owner> <repo> <issueNumber> [minConfidence]
 *
 * Requires GITHUB_TOKEN in env (the one the GUI uses works fine).
 */
import { GitHubService } from '../src/services/github.service.js';
import { detectBugSignal } from '../src/actions/autofix/bug-signal.js';
import type { StoredIssue } from '../src/store/store.model.js';

async function main() {
  const [owner, repo, numberRaw, minConfRaw] = process.argv.slice(2);
  if (!owner || !repo || !numberRaw) {
    console.error('Usage: diag-bug-signal.ts <owner> <repo> <issueNumber> [minConfidence]');
    process.exit(2);
  }
  const issueNumber = Number(numberRaw);
  const minConfidence = minConfRaw ? Number(minConfRaw) : 0.6;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN must be set');
    process.exit(2);
  }

  const github = new GitHubService({ github: { owner, repo, token } } as never);
  const { issue: live } = await github.getIssueWithComments(issueNumber);

  console.log('── live GitHub state ───────────────────────────────────────');
  console.log('title :', JSON.stringify(live.title));
  console.log('state :', live.state);
  console.log('labels:', JSON.stringify(live.labels));

  const synthesized: StoredIssue = {
    number: live.number,
    title: live.title,
    body: live.body,
    state: live.state,
    labels: live.labels,
    assignees: [],
    author: live.author,
    createdAt: live.createdAt,
    updatedAt: live.updatedAt,
    htmlUrl: live.htmlUrl,
    contentHash: 'diag',
    commentCount: 0,
    reactions: 0,
    comments: [],
    commentsFetchedAt: null,
    digest: null,
    analysis: { issueType: null, bugConfidence: null, autofixStatus: null } as StoredIssue['analysis'],
  };

  const signal = detectBugSignal(synthesized, { minConfidence });
  console.log('\n── bug-signal verdict ───────────────────────────────────');
  console.log('isBug            :', signal.isBug);
  console.log('isHighConfidence :', signal.isHighConfidence);
  console.log('reason           :', signal.reason);
}

main().catch((err) => {
  console.error('diag failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
