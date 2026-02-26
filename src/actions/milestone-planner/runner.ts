import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { buildMilestonePlanPrompt, MilestonePlanResponseSchema } from './prompt.js';

export interface MilestoneSuggestion {
  name: string;
  theme: string;
  issues: Array<{ number: number; title: string; priority?: string }>;
  effort: 'small' | 'medium' | 'large';
  rationale: string;
}

export class MilestonePlanResults {
  constructor(
    public readonly milestones: MilestoneSuggestion[],
    public readonly unassigned: Array<{ number: number; title: string }>,
    public readonly store: IssueStore,
    public readonly message?: string,
  ) {}

  static empty(message: string): MilestonePlanResults {
    return new MilestonePlanResults([], [], null as unknown as IssueStore, message);
  }

  get isEmpty(): boolean {
    return this.milestones.length === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }

    if (this.isEmpty) {
      console.log('No milestone plan generated.');
      return;
    }

    for (const [i, ms] of this.milestones.entries()) {
      console.log(`\nMILESTONE ${i + 1}: ${ms.name}`);
      console.log(`  Theme: ${ms.theme}`);
      console.log(`  Effort: ${ms.effort}`);
      for (const issue of ms.issues) {
        const p = issue.priority ? `${issue.priority.padEnd(9)} ` : '';
        console.log(`    #${issue.number} ${p}${issue.title}`);
      }
    }

    if (this.unassigned.length > 0) {
      console.log(`\nUNASSIGNED (${this.unassigned.length} issues)`);
      for (const issue of this.unassigned) {
        console.log(`    #${issue.number} ${issue.title}`);
      }
    }
  }
}

export class MilestonePlanRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async plan(): Promise<MilestonePlanResults> {
    const openIssues = this.store.getIssues({ state: 'open', hasDigest: true });

    if (openIssues.length < 3) {
      return MilestonePlanResults.empty('Need at least 3 open issues for meaningful grouping.');
    }

    const spinner = ora(`Analyzing ${openIssues.length} open issue(s) for theme clustering...`).start();

    const llm = this.llmService ?? new LLMService(this.config);
    const prompt = buildMilestonePlanPrompt(openIssues);
    const parsed = await llm.analyze(prompt, MilestonePlanResponseSchema);

    if (!parsed) {
      spinner.fail('Failed to generate milestone plan');
      return MilestonePlanResults.empty('LLM failed to generate milestone plan.');
    }

    // Resolve issue numbers to titles and priorities
    const milestones: MilestoneSuggestion[] = parsed.milestones.map(ms => ({
      name: ms.name,
      theme: ms.theme,
      effort: ms.effort,
      rationale: ms.rationale,
      issues: ms.issues.map(num => {
        const issue = this.store.getIssue(num);
        return {
          number: num,
          title: issue?.title ?? `Issue #${num}`,
          priority: issue?.analysis.priority ?? undefined,
        };
      }),
    }));

    const unassigned = parsed.unassigned.map(num => {
      const issue = this.store.getIssue(num);
      return { number: num, title: issue?.title ?? `Issue #${num}` };
    });

    spinner.succeed(`Milestone plan generated — ${milestones.length} milestone(s)`);
    return new MilestonePlanResults(milestones, unassigned, this.store);
  }
}
