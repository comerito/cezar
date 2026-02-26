import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildPriorityPrompt, PriorityResponseSchema } from './prompt.js';

const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export interface PriorityOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface PrioritizedIssue {
  number: number;
  title: string;
  htmlUrl: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  signals: string[];
}

export class PriorityResults {
  constructor(
    public readonly items: PrioritizedIssue[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): PriorityResults {
    return new PriorityResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No issues to prioritize.');
      return;
    }

    for (const item of this.items) {
      console.log(`  [${item.priority}] #${item.number}: ${item.reason}`);
      console.log(`    Signals: ${item.signals.join(', ')}`);
      console.log('');
    }
    console.log(`Prioritized ${this.items.length} issue(s).`);
  }
}

export class PriorityRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: PriorityOptions = {}): Promise<PriorityResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    const candidates = options.recheck
      ? allIssues
      : allIssues.filter(i => i.analysis.priorityAnalyzedAt === null);

    if (candidates.length === 0) {
      return PriorityResults.empty('All issues already scored. Use --recheck to re-run.');
    }

    const spinner = ora(`Scoring ${candidates.length} issue(s)...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.priorityBatchSize);
    const allItems: PrioritizedIssue[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildPriorityPrompt(batch);
      const parsed = await llm.analyze(prompt, PriorityResponseSchema);

      if (parsed) {
        for (const result of parsed.priorities) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          this.store.setAnalysis(result.number, {
            priority: result.priority,
            priorityReason: result.reason,
            prioritySignals: result.signals,
            priorityAnalyzedAt: new Date().toISOString(),
          });

          allItems.push({
            number: result.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            priority: result.priority,
            reason: result.reason,
            signals: result.signals,
          });
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.priorities.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            priorityAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    // Sort by priority: critical → high → medium → low
    allItems.sort((a, b) =>
      PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
    );

    spinner.succeed(`Analysis complete — ${allItems.length} issue(s) scored`);
    return new PriorityResults(allItems, this.store);
  }
}
