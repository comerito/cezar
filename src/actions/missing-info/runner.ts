import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildMissingInfoPrompt, MissingInfoResponseSchema } from './prompt.js';

export interface MissingInfoOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface MissingInfoItem {
  number: number;
  title: string;
  htmlUrl: string;
  missingFields: string[];
  suggestedComment: string;
}

export class MissingInfoResults {
  constructor(
    public readonly items: MissingInfoItem[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): MissingInfoResults {
    return new MissingInfoResults([], null as unknown as IssueStore, message);
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
      console.log('No issues with missing information found.');
      return;
    }

    for (const item of this.items) {
      console.log(`  #${item.number}: missing ${item.missingFields.join(', ')}`);
    }
    console.log(`\nFound ${this.items.length} issue(s) with missing information.`);
  }
}

export class MissingInfoRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async detect(options: MissingInfoOptions = {}): Promise<MissingInfoResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allBugs = this.store.getIssues({ state, hasDigest: true })
      .filter(i => i.digest?.category === 'bug');

    const candidates = options.recheck
      ? allBugs
      : allBugs.filter(i => i.analysis.missingInfoAnalyzedAt === null);

    if (candidates.length === 0) {
      return MissingInfoResults.empty('All bug reports already checked. Use --recheck to re-run.');
    }

    const spinner = ora(`Checking ${candidates.length} bug report(s) for missing info...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.missingInfoBatchSize);
    const allItems: MissingInfoItem[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildMissingInfoPrompt(batch);
      const parsed = await llm.analyze(prompt, MissingInfoResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          if (result.hasMissingInfo) {
            this.store.setAnalysis(result.number, {
              missingInfoFields: result.missingFields,
              missingInfoComment: result.suggestedComment,
              missingInfoAnalyzedAt: new Date().toISOString(),
            });

            allItems.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              missingFields: result.missingFields,
              suggestedComment: result.suggestedComment,
            });
          } else {
            this.store.setAnalysis(result.number, {
              missingInfoAnalyzedAt: new Date().toISOString(),
            });
          }
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            missingInfoAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Analysis complete — ${allItems.length} issue(s) need more info`);
    return new MissingInfoResults(allItems, this.store);
  }
}
