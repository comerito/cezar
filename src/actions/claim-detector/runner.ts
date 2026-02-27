import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { detectClaim, type ClaimMatch } from './patterns.js';

export interface ClaimDetectorOptions {
  recheck?: boolean;
  dryRun?: boolean;
}

export interface ClaimIssueResult {
  number: number;
  title: string;
  htmlUrl: string;
  claimant: string;
  snippet: string;
  claimedAt: string;
}

export class ClaimDetectorResults {
  constructor(
    public readonly items: ClaimIssueResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): ClaimDetectorResults {
    return new ClaimDetectorResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get claimed(): ClaimIssueResult[] {
    return this.items;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No claim comments detected.');
      return;
    }

    console.log(`\nClaim detector: ${this.items.length} issue(s) with claims`);
    console.log('');

    for (const item of this.items) {
      console.log(`  #${item.number}  ${item.title}`);
      console.log(`    Claimant: @${item.claimant} — "${item.snippet}"`);
      console.log('');
    }
  }
}

export class ClaimDetectorRunner {
  private store: IssueStore;
  private config: Config;

  constructor(store: IssueStore, config: Config) {
    this.store = store;
    this.config = config;
  }

  async detect(options: ClaimDetectorOptions = {}): Promise<ClaimDetectorResults> {
    const openIssues = this.store.getIssues({ state: 'open' });

    if (openIssues.length === 0) {
      return ClaimDetectorResults.empty('No open issues found.');
    }

    // Filter to unanalyzed + comment-updated unless recheck
    const unanalyzed = openIssues.filter(i => i.analysis.claimDetectedAt === null);
    const commentUpdated = openIssues.filter(i =>
      i.analysis.claimDetectedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.claimDetectedAt,
    );
    const candidates = options.recheck
      ? openIssues
      : [...unanalyzed, ...commentUpdated];

    if (candidates.length === 0) {
      return ClaimDetectorResults.empty('All open issues already checked. Use --recheck to re-run.');
    }

    const spinner = ora(`Scanning comments for ${candidates.length} issue(s)...`).start();

    const allResults: ClaimIssueResult[] = [];

    for (const [idx, issue] of candidates.entries()) {
      spinner.text = `Scanning comments for #${issue.number} (${idx + 1}/${candidates.length})...`;

      // Use stored comments instead of fetching from GitHub API
      const comments = issue.comments;

      // Scan all comments, keep the latest claim
      let latestClaim: ClaimMatch | null = null;
      for (const comment of comments) {
        const claim = detectClaim(comment);
        if (claim) {
          // Latest claim wins (comments are in chronological order)
          latestClaim = claim;
        }
      }

      if (latestClaim) {
        // Skip if claimant is already assigned to this issue
        if (issue.assignees.includes(latestClaim.author)) {
          this.store.setAnalysis(issue.number, {
            claimDetectedBy: latestClaim.author,
            claimComment: latestClaim.snippet,
            claimDetectedAt: new Date().toISOString(),
          });
          continue;
        }

        this.store.setAnalysis(issue.number, {
          claimDetectedBy: latestClaim.author,
          claimComment: latestClaim.snippet,
          claimDetectedAt: new Date().toISOString(),
        });

        allResults.push({
          number: issue.number,
          title: issue.title,
          htmlUrl: issue.htmlUrl,
          claimant: latestClaim.author,
          snippet: latestClaim.snippet,
          claimedAt: latestClaim.createdAt,
        });
      } else {
        // No claim found — mark as analyzed
        this.store.setAnalysis(issue.number, {
          claimDetectedBy: null,
          claimComment: null,
          claimDetectedAt: new Date().toISOString(),
        });
      }
    }

    if (!options.dryRun) {
      await this.store.save();
    }

    const claimCount = allResults.length;
    spinner.succeed(`Claim detector complete — ${claimCount} issue(s) with claims found`);

    return new ClaimDetectorResults(allResults, this.store);
  }
}
