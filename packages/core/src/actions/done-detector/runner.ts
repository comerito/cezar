import type { Config } from '../../config/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { GitHubService } from '../../services/github.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildDoneDetectorPrompt, DoneDetectorResponseSchema, type IssueWithPRs } from './prompt.js';

export type DoneDetectorProgressStage = 'fetch' | 'analyze';

export interface DoneDetectorProgress {
  stage: DoneDetectorProgressStage;
  current: number;
  total: number;
  message?: string;
}

export interface DoneDetectorOptions {
  recheck?: boolean;
  dryRun?: boolean;
  onProgress?: (p: DoneDetectorProgress) => void;
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
    const github = this.githubService ?? new GitHubService(this.config);
    const onProgress = options.onProgress;

    const issuesWithPRs: IssueWithPRs[] = [];

    onProgress?.({ stage: 'fetch', current: 0, total: candidates.length, message: `Fetching timelines for ${candidates.length} issues...` });

    for (const [idx, issue] of candidates.entries()) {
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
      } finally {
        onProgress?.({ stage: 'fetch', current: idx + 1, total: candidates.length });
      }
    }

    if (!options.dryRun) {
      await this.store.save();
    }

    if (issuesWithPRs.length === 0) {

      return new DoneDetectorResults([], this.store);
    }

    // Phase 2: LLM assessment
    const llm = this.llmService ?? new LLMService(this.config);
    const batchSize = this.config.sync.doneDetectorBatchSize;
    const batches = chunkArray(issuesWithPRs, batchSize);
    const allResults: DoneIssueResult[] = [];

    onProgress?.({ stage: 'analyze', current: 0, total: issuesWithPRs.length, message: `Analyzing ${issuesWithPRs.length} issues with merged PRs...` });

    let analyzed = 0;
    for (const [i, batch] of batches.entries()) {
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

      analyzed += batch.length;
      onProgress?.({ stage: 'analyze', current: analyzed, total: issuesWithPRs.length });
    }

    // Sort: resolved issues first, by confidence descending
    allResults.sort((a, b) => {
      if (a.isDone !== b.isDone) return a.isDone ? -1 : 1;
      return b.confidence - a.confidence;
    });

    const resolvedCount = allResults.filter(r => r.isDone).length;

    return new DoneDetectorResults(allResults, this.store);
  }
}
