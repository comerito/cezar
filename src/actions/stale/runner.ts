import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildStaleAnalysisPrompt, StaleAnalysisResponseSchema } from './prompt.js';

export interface StaleOptions {
  daysThreshold?: number;
  recheck?: boolean;
  dryRun?: boolean;
}

export interface StaleIssueResult {
  number: number;
  title: string;
  htmlUrl: string;
  daysSinceUpdate: number;
  action: 'close-resolved' | 'close-wontfix' | 'label-stale' | 'keep-open';
  reason: string;
  draftComment: string;
}

const ACTION_ORDER = ['close-resolved', 'close-wontfix', 'label-stale', 'keep-open'] as const;

export class StaleResults {
  constructor(
    public readonly items: StaleIssueResult[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): StaleResults {
    return new StaleResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  get actionCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.items) {
      counts[item.action] = (counts[item.action] ?? 0) + 1;
    }
    return counts;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No stale issues found.');
      return;
    }

    const counts = this.actionCounts;
    console.log(`\nStale issues: ${this.items.length}`);
    for (const action of ACTION_ORDER) {
      if (counts[action]) {
        console.log(`  ${action}: ${counts[action]}`);
      }
    }

    console.log('');
    for (const item of this.items) {
      console.log(`  #${item.number} [${item.action}] ${item.title} (${item.daysSinceUpdate}d inactive)`);
      console.log(`    ${item.reason}`);
      console.log('');
    }
  }
}

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

export class StaleRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: StaleOptions = {}): Promise<StaleResults> {
    const threshold = options.daysThreshold ?? this.config.sync.staleDaysThreshold;
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });

    // Filter to stale issues
    const staleIssues = openIssues
      .map(i => ({ ...i, daysSinceUpdate: daysSince(i.updatedAt) }))
      .filter(i => i.daysSinceUpdate >= threshold);

    if (staleIssues.length === 0) {
      return StaleResults.empty(`No issues inactive for ${threshold}+ days.`);
    }

    // Filter to unanalyzed + comment-updated unless recheck
    const unanalyzed = staleIssues.filter(i => i.analysis.staleAnalyzedAt === null);
    const commentUpdated = staleIssues.filter(i =>
      i.analysis.staleAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.staleAnalyzedAt,
    );
    const candidates = options.recheck
      ? staleIssues
      : [...unanalyzed, ...commentUpdated];

    if (candidates.length === 0) {
      return StaleResults.empty('All stale issues already analyzed. Use --recheck to re-run.');
    }

    const spinner = ora(`Analyzing ${candidates.length} stale issue(s) (${threshold}+ days inactive)...`).start();

    // Get closed issues as context for cross-referencing
    const closedIssues = this.store.getIssues({ state: 'closed', hasDigest: true });

    const llm = this.llmService ?? new LLMService(this.config);
    const batchSize = this.config.sync.priorityBatchSize; // reuse priority batch size
    const batches = chunkArray(candidates, batchSize);
    const allResults: StaleIssueResult[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildStaleAnalysisPrompt(batch, closedIssues, this.config.sync.staleCloseDays);
      const parsed = await llm.analyze(prompt, StaleAnalysisResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = candidates.find(c => c.number === result.number);
          if (!issue) continue;

          this.store.setAnalysis(result.number, {
            staleAction: result.action,
            staleReason: result.reason,
            staleDraftComment: result.draftComment || null,
            staleAnalyzedAt: new Date().toISOString(),
          });

          allResults.push({
            number: result.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            daysSinceUpdate: issue.daysSinceUpdate,
            action: result.action,
            reason: result.reason,
            draftComment: result.draftComment,
          });
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            staleAction: 'keep-open',
            staleReason: 'No suggestion from analysis',
            staleAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    // Sort by action priority: close-resolved, close-wontfix, label-stale, keep-open
    allResults.sort((a, b) =>
      ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action),
    );

    spinner.succeed(`Stale analysis complete — ${allResults.length} issue(s) triaged`);
    return new StaleResults(allResults, this.store);
  }
}
