import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildQualityCheckPrompt, QualityCheckResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface QualityOptions {
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export type QualityFlag = 'spam' | 'vague' | 'test' | 'wrong-language';

export interface QualityFlagged {
  number: number;
  title: string;
  htmlUrl: string;
  flag: QualityFlag;
  reason: string;
  suggestedLabel: string;
}

const FLAG_LABELS: Record<QualityFlag, string> = {
  spam: 'invalid',
  vague: 'needs-info',
  test: 'invalid',
  'wrong-language': 'invalid',
};

export class QualityResults {
  constructor(
    public readonly flagged: QualityFlagged[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): QualityResults {
    return new QualityResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.flagged.length === 0;
  }

  get flagCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.flagged) {
      counts[item.flag] = (counts[item.flag] ?? 0) + 1;
    }
    return counts;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No quality issues found — all issues look legitimate.');
      return;
    }

    const counts = this.flagCounts;
    console.log(`\nFlagged ${this.flagged.length} issue(s):`);
    for (const [flag, count] of Object.entries(counts)) {
      console.log(`  ${flag}: ${count}`);
    }

    console.log('');
    for (const item of this.flagged) {
      console.log(`  #${item.number} [${item.flag}] ${item.title}`);
      console.log(`    ${item.reason}`);
      console.log('');
    }
  }
}

export class QualityRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async check(options: QualityOptions = {}): Promise<QualityResults> {
    const openIssues = this.store.getIssues({ state: 'open' });

    const candidates = applyPipelineExclusions(
      options.recheck
        ? openIssues
        : openIssues.filter(i => i.analysis.qualityAnalyzedAt === null),
      options,
    );

    if (candidates.length === 0) {
      return QualityResults.empty('All open issues already checked. Use --recheck to re-run.');
    }

    const spinner = ora(`Checking ${candidates.length} issue(s) for quality...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.priorityBatchSize);
    const allFlagged: QualityFlagged[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Checking batch ${i + 1}/${batches.length}...`;

      const prompt = buildQualityCheckPrompt(batch);
      const parsed = await llm.analyze(prompt, QualityCheckResponseSchema);

      if (parsed) {
        for (const result of parsed.results) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          this.store.setAnalysis(result.number, {
            qualityFlag: result.quality,
            qualityReason: result.reason || null,
            qualityAnalyzedAt: new Date().toISOString(),
          });

          if (result.quality !== 'ok') {
            const flag = result.quality as QualityFlag;
            allFlagged.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              flag,
              reason: result.reason,
              suggestedLabel: result.suggestedLabel ?? FLAG_LABELS[flag],
            });
          }
        }
      }

      // Mark any candidates the LLM didn't return as analyzed (ok)
      for (const candidate of batch) {
        const wasReturned = parsed?.results.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            qualityFlag: 'ok',
            qualityAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    spinner.succeed(`Quality check complete — ${allFlagged.length} issue(s) flagged`);
    return new QualityResults(allFlagged, this.store);
  }
}
