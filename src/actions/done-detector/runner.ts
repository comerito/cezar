import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { GitHubService } from '../../services/github.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildDoneDetectorPrompt, DoneDetectorResponseSchema, type IssueWithPRs } from './prompt.js';

export interface DoneDetectorOptions {
  recheck?: boolean;
  dryRun?: boolean;
}

export interface DoneIssueResult {
  number: number;
  title: string;
  htmlUrl: string;
  isDone: boolean;
  confidence: number;
  reason: string;
  draftComment: string;
  mergedPRs: Array<{ prNumber: number; prTitle: string }>;
}

export class DoneDetectorResults {
  constructor(
    public readonly items: DoneIssueResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): DoneDetectorResults {
    return new DoneDetectorResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get resolved(): DoneIssueResult[] {
    return this.items.filter(i => i.isDone);
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No issues with merged PR references found.');
      return;
    }

    const done = this.resolved;
    const notDone = this.items.filter(i => !i.isDone);

    console.log(`\nDone detector: ${this.items.length} issue(s) checked`);
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
}

export class DoneDetectorRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;
  private githubService?: GitHubService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService, githubService?: GitHubService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
    this.githubService = githubService;
  }

  async detect(options: DoneDetectorOptions = {}): Promise<DoneDetectorResults> {
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });

    if (openIssues.length === 0) {
      return DoneDetectorResults.empty('No open issues with digest.');
    }

    // Filter to unanalyzed unless recheck
    const candidates = options.recheck
      ? openIssues
      : openIssues.filter(i => i.analysis.doneAnalyzedAt === null);

    if (candidates.length === 0) {
      return DoneDetectorResults.empty('All open issues already checked. Use --recheck to re-run.');
    }

    // Phase 1: Fetch timelines from GitHub
    const spinner = ora(`Fetching timelines for ${candidates.length} issue(s)...`).start();
    const github = this.githubService ?? new GitHubService(this.config);

    const issuesWithPRs: IssueWithPRs[] = [];

    for (const [idx, issue] of candidates.entries()) {
      spinner.text = `Fetching timeline for #${issue.number} (${idx + 1}/${candidates.length})...`;

      try {
        const crossRefs = await github.getIssueTimeline(issue.number);

        if (crossRefs.length === 0) {
          // No merged PRs — mark as not done
          this.store.setAnalysis(issue.number, {
            doneDetected: false,
            doneConfidence: null,
            doneReason: null,
            doneDraftComment: null,
            doneMergedPRs: null,
            doneAnalyzedAt: new Date().toISOString(),
          });
          continue;
        }

        issuesWithPRs.push({
          issue,
          mergedPRs: crossRefs.map(cr => ({ prNumber: cr.prNumber, prTitle: cr.prTitle })),
        });
      } catch {
        // Timeline fetch failed — skip this issue silently
        continue;
      }
    }

    if (!options.dryRun) {
      await this.store.save();
    }

    if (issuesWithPRs.length === 0) {
      spinner.succeed('No issues with merged PR references found.');
      return new DoneDetectorResults([], this.store);
    }

    // Phase 2: LLM assessment
    spinner.text = `Assessing ${issuesWithPRs.length} issue(s) with merged PRs...`;

    const llm = this.llmService ?? new LLMService(this.config);
    const batchSize = this.config.sync.doneDetectorBatchSize;
    const batches = chunkArray(issuesWithPRs, batchSize);
    const allResults: DoneIssueResult[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Assessing batch ${i + 1}/${batches.length}...`;

      const prompt = buildDoneDetectorPrompt(batch);
      const parsed = await llm.analyze(prompt, DoneDetectorResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const candidate = batch.find(c => c.issue.number === result.number);
          if (!candidate) continue;

          this.store.setAnalysis(result.number, {
            doneDetected: result.isDone,
            doneConfidence: result.confidence,
            doneReason: result.reason,
            doneDraftComment: result.draftComment || null,
            doneMergedPRs: candidate.mergedPRs,
            doneAnalyzedAt: new Date().toISOString(),
          });

          allResults.push({
            number: result.number,
            title: candidate.issue.title,
            htmlUrl: candidate.issue.htmlUrl,
            isDone: result.isDone,
            confidence: result.confidence,
            reason: result.reason,
            draftComment: result.draftComment,
            mergedPRs: candidate.mergedPRs,
          });
        }
      }

      // Mark any candidates the LLM didn't return
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.issue.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.issue.number, {
            doneDetected: false,
            doneReason: 'No suggestion from analysis',
            doneMergedPRs: candidate.mergedPRs,
            doneAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    // Sort: resolved issues first, by confidence descending
    allResults.sort((a, b) => {
      if (a.isDone !== b.isDone) return a.isDone ? -1 : 1;
      return b.confidence - a.confidence;
    });

    const resolvedCount = allResults.filter(r => r.isDone).length;
    spinner.succeed(`Done detector complete — ${resolvedCount} likely resolved issue(s) found`);
    return new DoneDetectorResults(allResults, this.store);
  }
}
