import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { BugDetectorResponseSchema, buildBugDetectorPrompt } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface BugDetectorOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export interface BugClassification {
  number: number;
  title: string;
  htmlUrl: string;
  issueType: 'bug' | 'feature' | 'question' | 'other';
  confidence: number;
  reason: string;
}

export class BugDetectorResults {
  constructor(
    public readonly classifications: BugClassification[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): BugDetectorResults {
    return new BugDetectorResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.classifications.length === 0;
  }

  get bugs(): BugClassification[] {
    return this.classifications.filter(c => c.issueType === 'bug');
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }
    if (this.isEmpty) {
      console.log('No issues classified.');
      return;
    }

    const byType = {
      bug: this.classifications.filter(c => c.issueType === 'bug').length,
      feature: this.classifications.filter(c => c.issueType === 'feature').length,
      question: this.classifications.filter(c => c.issueType === 'question').length,
      other: this.classifications.filter(c => c.issueType === 'other').length,
    };

    console.log(`Classified ${this.classifications.length} issue(s):`);
    console.log(`  🐛 bug:      ${byType.bug}`);
    console.log(`  ✨ feature:  ${byType.feature}`);
    console.log(`  ❓ question: ${byType.question}`);
    console.log(`  📦 other:    ${byType.other}`);
  }
}

export class BugDetectorRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async analyze(options: BugDetectorOptions = {}): Promise<BugDetectorResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    const candidates = applyPipelineExclusions(
      options.recheck
        ? allIssues
        : allIssues.filter(i => i.analysis.bugAnalyzedAt === null),
      options,
    );

    if (candidates.length === 0) {
      return BugDetectorResults.empty('All issues already classified. Use --recheck to re-run.');
    }

    const spinner = ora(`Classifying ${candidates.length} issue(s)...`).start();
    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.bugDetectorBatchSize);
    const all: BugClassification[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Classifying batch ${i + 1}/${batches.length}...`;
      const prompt = buildBugDetectorPrompt(batch);
      const parsed = await llm.analyze(prompt, BugDetectorResponseSchema);

      if (parsed) {
        for (const r of parsed.classifications) {
          const issue = this.store.getIssue(r.number);
          if (!issue) continue;

          this.store.setAnalysis(r.number, {
            issueType: r.issueType,
            bugConfidence: r.confidence,
            bugReason: r.reason,
            bugAnalyzedAt: new Date().toISOString(),
          });

          all.push({
            number: r.number,
            title: issue.title,
            htmlUrl: issue.htmlUrl,
            issueType: r.issueType,
            confidence: r.confidence,
            reason: r.reason,
          });
        }
      }

      // Mark candidates the LLM didn't return — don't rerun them next time
      for (const candidate of batch) {
        const wasReturned = parsed?.classifications.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            bugAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Classification complete — ${all.length} issue(s) analyzed`);
    return new BugDetectorResults(all, this.store);
  }
}
