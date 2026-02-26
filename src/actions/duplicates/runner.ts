import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService, type DuplicateMatch } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';

export interface DuplicateOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
  format?: string;
}

export interface DuplicateGroup {
  original: StoredIssue;
  duplicate: StoredIssue;
  confidence: number;
  reason: string;
}

export class DuplicateResults {
  constructor(
    public readonly groups: DuplicateGroup[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): DuplicateResults {
    return new DuplicateResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.groups.length === 0;
  }

  print(format: string = 'table'): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No duplicates found.');
      return;
    }

    if (format === 'json') {
      console.log(JSON.stringify(this.groups.map(g => ({
        duplicate: g.duplicate.number,
        original: g.original.number,
        confidence: g.confidence,
        reason: g.reason,
      })), null, 2));
      return;
    }

    // Default: table format
    for (const group of this.groups) {
      console.log(`  #${group.duplicate.number} → duplicate of #${group.original.number} (${Math.round(group.confidence * 100)}%)`);
      console.log(`    ${group.reason}`);
      console.log('');
    }
    console.log(`Found ${this.groups.length} duplicate(s).`);
  }
}

export class DuplicatesRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async detect(options: DuplicateOptions = {}): Promise<DuplicateResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    // Candidates = unanalyzed issues (or all if --recheck)
    const candidates = options.recheck
      ? allIssues
      : allIssues.filter(i => i.analysis.duplicatesAnalyzedAt === null);

    if (candidates.length === 0) {
      return DuplicateResults.empty('All issues already analyzed. Use --recheck to re-run.');
    }

    // All digested issues form the knowledge base
    const knowledgeBase = allIssues;

    const spinner = ora(`Checking ${candidates.length} issues against ${knowledgeBase.length} total...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.duplicateBatchSize);
    const allGroups: DuplicateGroup[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Analyzing batch ${i + 1}/${batches.length}...`;

      const batchResults = await llm.detectDuplicates(batch, knowledgeBase);

      // Persist each batch to store immediately (crash-safe)
      for (const match of batchResults) {
        this.store.setAnalysis(match.number, {
          duplicateOf: match.duplicateOf,
          duplicateConfidence: match.confidence,
          duplicateReason: match.reason,
          duplicatesAnalyzedAt: new Date().toISOString(),
        });
      }

      // Mark non-duplicates as analyzed too
      for (const candidate of batch) {
        const isMatch = batchResults.some(r => r.number === candidate.number);
        if (!isMatch) {
          this.store.setAnalysis(candidate.number, {
            duplicatesAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }

      // Build groups for display
      for (const match of batchResults) {
        const duplicate = this.store.getIssue(match.number);
        const original = this.store.getIssue(match.duplicateOf);
        if (duplicate && original) {
          allGroups.push({
            original,
            duplicate,
            confidence: match.confidence,
            reason: match.reason,
          });
        }
      }
    }

    spinner.succeed(`Analysis complete — ${allGroups.length} duplicate(s) found`);
    return new DuplicateResults(allGroups, this.store);
  }
}
