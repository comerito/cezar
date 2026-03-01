import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { buildIssueCheckPrompt, IssueCheckResponseSchema } from './prompt.js';

export interface IssueCheckOptions {
  description: string;
  dryRun?: boolean;
}

export interface IssueCheckMatch {
  issue: StoredIssue;
  confidence: number;
  reason: string;
}

export class IssueCheckResults {
  constructor(
    public readonly matches: IssueCheckMatch[],
    public readonly description: string,
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(description: string, message: string): IssueCheckResults {
    return new IssueCheckResults([], description, null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.matches.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No matching issues found.');
      return;
    }

    for (const match of this.matches) {
      console.log(`  #${match.issue.number} (${Math.round(match.confidence * 100)}%) — ${match.issue.title}`);
      console.log(`    ${match.reason}`);
      console.log('');
    }
    console.log(`Found ${this.matches.length} potential match(es).`);
  }
}

export class IssueCheckRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async check(options: IssueCheckOptions): Promise<IssueCheckResults> {
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });

    if (openIssues.length === 0) {
      return IssueCheckResults.empty(options.description, 'No open issues with digest to check against.');
    }

    const spinner = ora(`Checking description against ${openIssues.length} open issue(s)...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const prompt = buildIssueCheckPrompt(options.description, openIssues);
    const parsed = await llm.analyze(prompt, IssueCheckResponseSchema);

    if (!parsed) {
      spinner.fail('Failed to parse LLM response');
      return IssueCheckResults.empty(options.description, 'LLM response could not be parsed.');
    }

    const matches: IssueCheckMatch[] = [];
    for (const match of parsed.matches) {
      const issue = this.store.getIssue(match.number);
      if (issue) {
        matches.push({
          issue,
          confidence: match.confidence,
          reason: match.reason,
        });
      }
    }

    // Sort by confidence descending
    matches.sort((a, b) => b.confidence - a.confidence);

    spinner.succeed(`Check complete — ${matches.length} match(es) found`);
    return new IssueCheckResults(matches, options.description, this.store);
  }
}
