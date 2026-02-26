import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { GitHubService } from '../../services/github.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildLabelPrompt, LabelResponseSchema } from './prompt.js';

export interface LabelOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
}

export interface LabelSuggestion {
  number: number;
  title: string;
  htmlUrl: string;
  currentLabels: string[];
  suggestedLabels: string[];
  reason: string;
}

export class LabelResults {
  constructor(
    public readonly suggestions: LabelSuggestion[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): LabelResults {
    return new LabelResults([], null as unknown as IssueStore, message);
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
      console.log('No label suggestions found.');
      return;
    }

    for (const s of this.suggestions) {
      const current = s.currentLabels.length > 0 ? s.currentLabels.join(', ') : '(none)';
      console.log(`  #${s.number}: ${current} → +${s.suggestedLabels.join(', +')}`);
      console.log(`    ${s.reason}`);
      console.log('');
    }
    console.log(`Found ${this.suggestions.length} issue(s) needing labels.`);
  }
}

export class AutoLabelRunner {
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

  async analyze(options: LabelOptions = {}): Promise<LabelResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    const candidates = options.recheck
      ? allIssues
      : allIssues.filter(i => i.analysis.labelsAnalyzedAt === null);

    if (candidates.length === 0) {
      return LabelResults.empty('All issues already analyzed. Use --recheck to re-run.');
    }

    // Fetch repo labels once
    const spinner = ora('Fetching repository labels...').start();
    const github = this.githubService ?? new GitHubService(this.config);
    let repoLabels: string[];
    try {
      repoLabels = await github.fetchRepoLabels();
    } catch (error) {
      spinner.fail('Failed to fetch repository labels');
      throw error;
    }

    if (repoLabels.length === 0) {
      spinner.fail('Repository has no labels defined');
      return LabelResults.empty('No labels defined in the repository. Create labels on GitHub first.');
    }

    spinner.text = `Analyzing ${candidates.length} issue(s) against ${repoLabels.length} labels...`;

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.labelBatchSize);
    const allSuggestions: LabelSuggestion[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const prompt = buildLabelPrompt(batch, repoLabels);
      const parsed = await llm.analyze(prompt, LabelResponseSchema);

      if (parsed) {
        for (const result of parsed.labels) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          // Filter to only valid repo labels and labels not already on the issue
          const newLabels = result.suggested
            .filter(l => repoLabels.includes(l))
            .filter(l => !issue.labels.includes(l));

          this.store.setAnalysis(result.number, {
            suggestedLabels: newLabels.length > 0 ? newLabels : null,
            labelsReason: newLabels.length > 0 ? result.reason : null,
            labelsAnalyzedAt: new Date().toISOString(),
          });

          if (newLabels.length > 0) {
            allSuggestions.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              currentLabels: issue.labels,
              suggestedLabels: newLabels,
              reason: result.reason,
            });
          }
        }
      }

      // Mark candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.labels.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            labelsAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Analysis complete — ${allSuggestions.length} issue(s) need labels`);
    return new LabelResults(allSuggestions, this.store);
  }
}
