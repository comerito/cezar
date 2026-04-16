import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildCategorizePrompt, CategorizeResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface CategorizeOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export interface CategorizeSuggestion {
  number: number;
  title: string;
  htmlUrl: string;
  currentLabels: string[];
  category: 'framework' | 'domain' | 'integration';
  reason: string;
}

export class CategorizeResults {
  constructor(
    public readonly suggestions: CategorizeSuggestion[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): CategorizeResults {
    return new CategorizeResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.suggestions.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No categorization suggestions found.');
      return;
    }

    for (const s of this.suggestions) {
      console.log(`  #${s.number}: ${s.category}`);
      console.log(`    ${s.reason}`);
      console.log('');
    }
    console.log(`Categorized ${this.suggestions.length} issue(s).`);
  }
}

export class CategorizeRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: CategorizeOptions = {}): Promise<CategorizeResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    const candidates = applyPipelineExclusions(
      options.recheck
        ? allIssues
        : allIssues.filter(i => i.analysis.featureCategoryAnalyzedAt === null),
      options,
    );

    if (candidates.length === 0) {
      return CategorizeResults.empty('All issues already categorized. Use --recheck to re-run.');
    }

    const spinner = ora(`Categorizing ${candidates.length} issue(s)...`).start();
    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.categorizeBatchSize);
    const allSuggestions: CategorizeSuggestion[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Categorizing batch ${i + 1}/${batches.length}...`;

      const prompt = buildCategorizePrompt(batch);
      const parsed = await llm.analyze(prompt, CategorizeResponseSchema);

      if (parsed) {
        for (const result of parsed.categories) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          this.store.setAnalysis(result.number, {
            featureCategory: result.category,
            featureCategoryReason: result.reason,
            featureCategoryAnalyzedAt: new Date().toISOString(),
          });

          allSuggestions.push({
            number: result.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            currentLabels: issue.labels,
            category: result.category,
            reason: result.reason,
          });
        }
      }

      // Mark candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.categories.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            featureCategoryAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Categorization complete — ${allSuggestions.length} issue(s) categorized`);
    return new CategorizeResults(allSuggestions, this.store);
  }
}
