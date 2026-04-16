import type { Config } from '../../config/config.model.js';
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

    const llm = this.llmService ?? new LLMService(this.config);
    const prompt = buildIssueCheckPrompt(options.description, openIssues);
    const parsed = await llm.analyze(prompt, IssueCheckResponseSchema);

    if (!parsed) {

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

    return new IssueCheckResults(matches, options.description, this.store);
  }
}
