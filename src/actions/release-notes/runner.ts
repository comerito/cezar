import ora from 'ora';
import type { Config } from '../../models/config.model.js';
import type { StoredIssue } from '../../store/store.model.js';
import { IssueStore } from '../../store/store.js';
import { LLMService } from '../../services/llm.service.js';
import { buildReleaseNotesPrompt, ReleaseNotesResponseSchema } from './prompt.js';
import { applyPipelineExclusions } from '../../pipeline/close-flag.js';

export interface ReleaseNotesOptions {
  since?: string;
  until?: string;
  issues?: number[];
  versionTag?: string;
  excludeIssues?: Set<number>;
}

export class ReleaseNotesResult {
  constructor(
    public readonly markdown: string,
    public readonly issueCount: number,
    public readonly message?: string,
  ) {}

  static empty(message: string): ReleaseNotesResult {
    return new ReleaseNotesResult('', 0, message);
  }

  get isEmpty(): boolean {
    return this.issueCount === 0;
  }

  print(): void {
    if (this.message) {
      console.log(this.message);
      return;
    }
    console.log(this.markdown);
  }
}

export class ReleaseNotesRunner {
  private store: IssueStore;
  private config: Config;
  private llmService?: LLMService;

  constructor(store: IssueStore, config: Config, llmService?: LLMService) {
    this.store = store;
    this.config = config;
    this.llmService = llmService;
  }

  async generate(options: ReleaseNotesOptions = {}): Promise<ReleaseNotesResult> {
    const selectedIssues = applyPipelineExclusions(this.selectIssues(options), options);

    if (selectedIssues.length === 0) {
      return ReleaseNotesResult.empty('No closed issues found for the given criteria.');
    }

    const spinner = ora(`Generating release notes from ${selectedIssues.length} issue(s)...`).start();

    // Gather previously known authors (from issues NOT in this release)
    const releaseNumbers = new Set(selectedIssues.map(i => i.number));
    const allClosedIssues = this.store.getIssues({ state: 'closed', hasDigest: true });
    const previousAuthors = new Set<string>();
    for (const issue of allClosedIssues) {
      if (!releaseNumbers.has(issue.number)) {
        previousAuthors.add(issue.author);
      }
    }

    const llm = this.llmService ?? new LLMService(this.config);
    const prompt = buildReleaseNotesPrompt(selectedIssues, previousAuthors, options.versionTag);
    const parsed = await llm.analyze(prompt, ReleaseNotesResponseSchema);

    if (!parsed) {
      spinner.fail('Failed to generate release notes');
      return ReleaseNotesResult.empty('LLM failed to generate release notes.');
    }

    const markdown = this.buildMarkdown(parsed, options.versionTag);

    spinner.succeed(`Release notes generated from ${selectedIssues.length} issue(s)`);
    return new ReleaseNotesResult(markdown, selectedIssues.length);
  }

  private selectIssues(options: ReleaseNotesOptions): StoredIssue[] {
    if (options.issues && options.issues.length > 0) {
      return options.issues
        .map(n => this.store.getIssue(n))
        .filter((i): i is StoredIssue => i !== undefined && i.digest !== null);
    }

    const closedWithDigest = this.store.getIssues({ state: 'closed', hasDigest: true });

    if (options.since || options.until) {
      return closedWithDigest.filter(i => {
        if (options.since && i.updatedAt < options.since) return false;
        if (options.until && i.updatedAt > options.until) return false;
        return true;
      });
    }

    // Default: all closed issues with digest
    return closedWithDigest;
  }

  private buildMarkdown(
    parsed: { sections: Array<{ heading: string; emoji: string; items: Array<{ description: string; issues: number[] }> }>; contributors: Array<{ username: string; isFirstTime: boolean }> },
    versionTag?: string,
  ): string {
    const lines: string[] = [];
    const date = new Date().toISOString().split('T')[0];
    const title = versionTag ? `## ${versionTag} — ${date}` : `## Release Notes — ${date}`;
    lines.push(title);
    lines.push('');

    for (const section of parsed.sections) {
      if (section.items.length === 0) continue;
      lines.push(`### ${section.emoji} ${section.heading}`);
      lines.push('');
      for (const item of section.items) {
        const refs = item.issues.map(n => `#${n}`).join(', ');
        lines.push(`- ${item.description} (${refs})`);
      }
      lines.push('');
    }

    if (parsed.contributors.length > 0) {
      lines.push('### Contributors');
      lines.push('');
      const firstTimers = parsed.contributors.filter(c => c.isFirstTime);
      const returning = parsed.contributors.filter(c => !c.isFirstTime);

      for (const c of returning) {
        lines.push(`- @${c.username}`);
      }
      for (const c of firstTimers) {
        lines.push(`- @${c.username} *(first contribution!)*`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
