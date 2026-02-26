import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildWelcomePrompt, WelcomeResponseSchema } from './prompt.js';

export interface WelcomeOptions {
  recheck?: boolean;
  dryRun?: boolean;
}

export interface WelcomeCandidate {
  number: number;
  title: string;
  htmlUrl: string;
  author: string;
  category: string;
  welcomeMessage: string;
}

export class WelcomeResults {
  constructor(
    public readonly candidates: WelcomeCandidate[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): WelcomeResults {
    return new WelcomeResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.candidates.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No first-time contributors to welcome.');
      return;
    }

    for (const c of this.candidates) {
      console.log(`  #${c.number} @${c.author} [${c.category}]: ${c.title}`);
      console.log(`    ${c.welcomeMessage.split('\n')[0]}...`);
      console.log('');
    }
    console.log(`Found ${this.candidates.length} first-time contributor(s) to welcome.`);
  }
}

/**
 * Returns the set of authors who have more than one issue in the store.
 * An author with exactly one open issue and no other issues is first-time.
 */
export function findFirstTimeAuthors(store: IssueStore): Set<string> {
  const allIssues = store.getIssues({ state: 'all' });
  const authorCounts = new Map<string, number>();
  for (const issue of allIssues) {
    authorCounts.set(issue.author, (authorCounts.get(issue.author) ?? 0) + 1);
  }
  const firstTimers = new Set<string>();
  for (const [author, count] of authorCounts) {
    if (count === 1) firstTimers.add(author);
  }
  return firstTimers;
}

export class ContributorWelcomeRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: WelcomeOptions = {}): Promise<WelcomeResults> {
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });
    const firstTimers = findFirstTimeAuthors(this.store);

    // Filter to first-time contributors with open issues
    const firstTimeIssues = openIssues.filter(i => firstTimers.has(i.author));

    if (firstTimeIssues.length === 0) {
      return WelcomeResults.empty('No first-time contributors found among open issues.');
    }

    // Filter to unwelcomed unless recheck
    const candidates = options.recheck
      ? firstTimeIssues
      : firstTimeIssues.filter(i => i.analysis.welcomeCommentPostedAt === null);

    if (candidates.length === 0) {
      return WelcomeResults.empty('All first-time contributors already welcomed. Use --recheck to re-run.');
    }

    const spinner = ora(`Generating welcome messages for ${candidates.length} first-time contributor(s)...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.priorityBatchSize);
    const allCandidates: WelcomeCandidate[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Generating batch ${i + 1}/${batches.length}...`;

      const prompt = buildWelcomePrompt(batch, this.config.github.owner, this.config.github.repo);
      const parsed = await llm.analyze(prompt, WelcomeResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          allCandidates.push({
            number: result.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            author: issue.author,
            category: issue.digest?.category ?? 'other',
            welcomeMessage: result.welcomeMessage,
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Generated welcome messages for ${allCandidates.length} first-time contributor(s)`);
    return new WelcomeResults(allCandidates, this.store);
  }
}
