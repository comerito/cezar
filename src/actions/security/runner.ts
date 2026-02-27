import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { chunkArray } from '../../utils/chunker.js';
import { buildSecurityPrompt, SecurityResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface SecurityOptions {
  state?: 'open' | 'closed' | 'all';
  recheck?: boolean;
  dryRun?: boolean;
  excludeIssues?: Set<number>;
}

export interface SecurityFinding {
  number: number;
  title: string;
  htmlUrl: string;
  confidence: number;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  explanation: string;
}

export class SecurityResults {
  constructor(
    public readonly findings: SecurityFinding[],
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): SecurityResults {
    return new SecurityResults([], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.findings.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No security findings.');
      return;
    }

    for (const f of this.findings) {
      console.log(`  #${f.number} [${f.severity}] ${f.category} (${Math.round(f.confidence * 100)}%)`);
      console.log(`    ${f.explanation}`);
      console.log('');
    }
    console.log(`Found ${this.findings.length} potential security issue(s).`);
  }
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export class SecurityRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async scan(options: SecurityOptions = {}): Promise<SecurityResults> {
    const state = (options.state ?? 'open') as 'open' | 'closed' | 'all';
    // Security scans ALL categories — not just bugs
    const allIssues = this.store.getIssues({ state, hasDigest: true });

    const unanalyzed = allIssues.filter(i => i.analysis.securityAnalyzedAt === null);
    const commentUpdated = allIssues.filter(i =>
      i.analysis.securityAnalyzedAt !== null &&
      i.commentsFetchedAt !== null &&
      i.commentsFetchedAt > i.analysis.securityAnalyzedAt,
    );
    const candidates = applyPipelineExclusions(
      options.recheck ? allIssues : [...unanalyzed, ...commentUpdated],
      options,
    );

    if (candidates.length === 0) {
      return SecurityResults.empty('All issues already scanned. Use --recheck to re-run.');
    }

    const spinner = ora(`Scanning ${candidates.length} issue(s) for security implications...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const batches = chunkArray(candidates, this.config.sync.securityBatchSize);
    const allFindings: SecurityFinding[] = [];

    for (const [i, batch] of batches.entries()) {
      spinner.text = `Scanning batch ${i + 1}/${batches.length}...`;

      const prompt = buildSecurityPrompt(batch);
      const parsed = await llm.analyze(prompt, SecurityResponseSchema);

      if (parsed) {
        for (const result of parsed.findings) {
          const issue = this.store.getIssue(result.number);
          if (!issue) continue;

          if (result.isSecurityRelated && result.confidence >= 0.70) {
            this.store.setAnalysis(result.number, {
              securityFlag: true,
              securityConfidence: result.confidence,
              securityCategory: result.category,
              securitySeverity: result.severity,
              securityAnalyzedAt: new Date().toISOString(),
            });

            allFindings.push({
              number: result.number,
              title: issue.title,
              htmlUrl: issue.htmlUrl,
              confidence: result.confidence,
              category: result.category,
              severity: result.severity,
              explanation: result.explanation,
            });
          } else {
            this.store.setAnalysis(result.number, {
              securityFlag: false,
              securityAnalyzedAt: new Date().toISOString(),
            });
          }
        }
      }

      // Mark any candidates the LLM didn't return as analyzed
      for (const candidate of batch) {
        const wasReturned = parsed?.findings.some(r => r.number === candidate.number);
        if (!wasReturned) {
          this.store.setAnalysis(candidate.number, {
            securityAnalyzedAt: new Date().toISOString(),
          });
        }
      }

      if (!options.dryRun) {
        await this.store.save();
      }
    }

    // Sort by severity: critical → high → medium → low
    allFindings.sort((a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
    );

    spinner.succeed(`Scan complete — ${allFindings.length} potential security issue(s) found`);
    return new SecurityResults(allFindings, this.store);
  }
}
