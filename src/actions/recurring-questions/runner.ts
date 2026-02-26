import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildRecurringQuestionPrompt, RecurringQuestionResponseSchema } from './prompt.js';

export interface RecurringQuestionOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface RecurringQuestionItem {
  number: number;
  title: string;
  htmlUrl: string;
  similarClosedIssues: Array<{ number: number; title: string }>;
  suggestedResponse: string;
  confidence: number;
}

export class RecurringQuestionResults {
  constructor(
    public readonly items: RecurringQuestionItem[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): RecurringQuestionResults {
    return new RecurringQuestionResults([], null as unknown as IssueStore, message);
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
      console.log('No recurring questions found.');
      return;
    }

    for (const item of this.items) {
      const refs = item.similarClosedIssues.map(i => `#${i.number}`).join(', ');
      console.log(`  #${item.number}: similar to ${refs}`);
      console.log(`    ${item.suggestedResponse.split('\n')[0]}`);
      console.log('');
    }
    console.log(`Found ${this.items.length} recurring question(s).`);
  }
}

export class RecurringQuestionRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async detect(options: RecurringQuestionOptions = {}): Promise<RecurringQuestionResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allQuestions = this.store.getIssues({ state, hasDigest: true })
      .filter(i => i.digest?.category === 'question');

    const candidates = options.recheck
      ? allQuestions
      : allQuestions.filter(i => i.analysis.recurringAnalyzedAt === null);

    if (candidates.length === 0) {
      return RecurringQuestionResults.empty('All questions already checked. Use --recheck to re-run.');
    }

    // Get closed issues as knowledge base
    const closedIssues = this.store.getIssues({ state: 'closed', hasDigest: true });
    if (closedIssues.length === 0) {
      return RecurringQuestionResults.empty('No closed issues to compare against.');
    }

    const spinner = ora(`Checking ${candidates.length} question(s) against ${closedIssues.length} closed issues...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.recurringBatchSize);
    const allItems: RecurringQuestionItem[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildRecurringQuestionPrompt(batch, closedIssues);
      const parsed = await llm.analyze(prompt, RecurringQuestionResponseSchema);

      if (parsed) {
        for (const result of parsed.questions) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          if (result.isRecurring && result.similarClosedIssues.length > 0) {
            this.store.setAnalysis(result.number, {
              isRecurringQuestion: true,
              similarClosedIssues: result.similarClosedIssues,
              suggestedResponse: result.suggestedResponse,
              recurringAnalyzedAt: new Date().toISOString(),
            });

            // Resolve closed issue titles for display
            const similarWithTitles = result.similarClosedIssues.map(num => {
              const closed = this.store.getIssue(num);
              return { number: num, title: closed?.title ?? `Issue #${num}` };
            });

            allItems.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              similarClosedIssues: similarWithTitles,
              suggestedResponse: result.suggestedResponse,
              confidence: result.confidence,
            });
          } else {
            this.store.setAnalysis(result.number, {
              isRecurringQuestion: false,
              recurringAnalyzedAt: new Date().toISOString(),
            });
          }
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.questions.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            recurringAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Analysis complete — ${allItems.length} recurring question(s) found`);
    return new RecurringQuestionResults(allItems, this.store);
  }
}
