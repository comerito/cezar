import type { Config } from '../../config/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildNeedsResponsePrompt, NeedsResponseResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface NeedsResponseOptions {
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export interface NeedsResponseItem {
  number: number;
  title: string;
  htmlUrl: string;
  status: 'needs-response' | 'responded' | 'new-issue';
  reason: string;
}

export class NeedsResponseResults {
  constructor(
    public readonly items: NeedsResponseItem[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): NeedsResponseResults {
    return new NeedsResponseResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get needsResponse(): NeedsResponseItem[] {
    return this.items.filter(i => i.status === 'needs-response' || i.status === 'new-issue');
  }
}

export class NeedsResponseRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: NeedsResponseOptions = {}): Promise<NeedsResponseResults> {
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });

    const unanalyzed = openIssues.filter(i => i.analysis.needsResponseAnalyzedAt === null);
    const commentUpdated = openIssues.filter(i =>
      i.analysis.needsResponseAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.needsResponseAnalyzedAt,
    );
    const candidates = applyPipelineExclusions(
      options.recheck ? openIssues : [...unanalyzed, ...commentUpdated],
      options,
    );

    if (candidates.length === 0) {
      return NeedsResponseResults.empty('All open issues already checked. Use --recheck to re-run.');
    }

    const meta = this.store.getMeta();
    const orgMembers = meta.orgMembers ?? [];

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.needsResponseBatchSize);
    const allItems: NeedsResponseItem[] = [];

    for (const [i, batch] of batches.entries()) {
      const prompt = buildNeedsResponsePrompt(batch, orgMembers);
      const parsed = await llm.analyze(prompt, NeedsResponseResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          this.store.setAnalysis(result.number, {
            needsResponseStatus: result.status,
            needsResponseReason: result.reason,
            needsResponseAnalyzedAt: new Date().toISOString(),
          });

          allItems.push({
            number: result.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            status: result.status,
            reason: result.reason,
          });
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            needsResponseAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    const awaitingCount = allItems.filter(i => i.status === 'needs-response' || i.status === 'new-issue').length;

    return new NeedsResponseResults(allItems, this.store);
  }
}
