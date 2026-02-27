import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildGoodFirstIssuePrompt, GoodFirstIssueResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface GoodFirstIssueOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export interface GoodFirstIssueSuggestion {
  number: number;
  title: string;
  htmlUrl: string;
  reason: string;
  codeHint: string;
  estimatedComplexity: 'trivial' | 'small' | 'medium';
}

export class GoodFirstIssueResults {
  constructor(
    public readonly suggestions: GoodFirstIssueSuggestion[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): GoodFirstIssueResults {
    return new GoodFirstIssueResults([], null as unknown as IssueStore, message);
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
      console.log('No good first issue candidates found.');
      return;
    }

    for (const s of this.suggestions) {
      console.log(`  #${s.number} [${s.estimatedComplexity}]: ${s.reason}`);
      console.log(`    Hint: ${s.codeHint}`);
      console.log('');
    }
    console.log(`Found ${this.suggestions.length} good first issue candidate(s).`);
  }
}

export class GoodFirstIssueRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: GoodFirstIssueOptions = {}): Promise<GoodFirstIssueResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true })
      .filter(i => !i.labels.includes('good first issue'));

    const candidates = applyPipelineExclusions(
      options.recheck
        ? allIssues
        : allIssues.filter(i => i.analysis.goodFirstIssueAnalyzedAt === null),
      options,
    );

    if (candidates.length === 0) {
      return GoodFirstIssueResults.empty('All issues already analyzed. Use --recheck to re-run.');
    }

    const spinner = ora(`Evaluating ${candidates.length} issue(s) for newcomer suitability...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.priorityBatchSize);
    const allSuggestions: GoodFirstIssueSuggestion[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildGoodFirstIssuePrompt(batch);
      const parsed = await llm.analyze(prompt, GoodFirstIssueResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          if (result.isGoodFirstIssue) {
            this.store.setAnalysis(result.number, {
              isGoodFirstIssue: true,
              goodFirstIssueReason: result.reason,
              goodFirstIssueHint: result.codeHint,
              goodFirstIssueAnalyzedAt: new Date().toISOString(),
            });

            allSuggestions.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              reason: result.reason,
              codeHint: result.codeHint,
              estimatedComplexity: result.estimatedComplexity,
            });
          } else {
            this.store.setAnalysis(result.number, {
              isGoodFirstIssue: false,
              goodFirstIssueAnalyzedAt: new Date().toISOString(),
            });
          }
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            goodFirstIssueAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Analysis complete — ${allSuggestions.length} good first issue candidate(s) found`);
    return new GoodFirstIssueResults(allSuggestions, this.store);
  }
}
