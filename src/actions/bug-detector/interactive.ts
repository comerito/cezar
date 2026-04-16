import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { BugClassification, BugDetectorResults } from './runner.js';

type Decision = 'keep' | 'override' | 'skip' | 'stop';

const TYPE_ICONS: Record<string, string> = {
  bug: '🐛',
  feature: '✨',
  question: '❓',
  other: '📦',
};

export class BugDetectorInteractiveUI {
  constructor(private readonly results: BugDetectorResults) {}

  async present(): Promise<void> {
    if (this.results.isEmpty) {
      console.log(this.results.message ?? 'No issues to review.');
      return;
    }

    console.log('');
    console.log(chalk.bold('Bug detection complete'));
    console.log('─'.repeat(55));
    this.results.print();
    console.log('');

    const lowConfidence = this.results.classifications.filter(c => c.confidence < 0.7);
    if (lowConfidence.length === 0) {
      console.log(chalk.dim('All classifications have confidence >= 0.7 — no review needed.'));
      return;
    }

    const shouldReview = await select<'review' | 'skip'>({
      message: `${lowConfidence.length} classification(s) have low confidence. Review them?`,
      choices: [
        { name: 'Review low-confidence classifications', value: 'review' },
        { name: 'Skip — keep model defaults', value: 'skip' },
      ],
    });

    if (shouldReview === 'skip') return;

    let stopped = false;
    for (const [i, c] of lowConfidence.entries()) {
      if (stopped) break;
      console.log(renderClassification(c, i, lowConfidence.length));
      const decision = await this.ask(c);
      if (decision === 'override') {
        const newType = await this.selectType(c.issueType);
        this.results.store.setAnalysis(c.number, {
          issueType: newType,
          bugConfidence: 1,
          bugReason: `Manual override (was ${c.issueType} @ ${c.confidence.toFixed(2)})`,
        });
        console.log(chalk.green(`  ✓ #${c.number} → ${newType}`));
      } else if (decision === 'stop') {
        stopped = true;
      }
    }

    await this.results.store.save();
  }

  private ask(c: BugClassification): Promise<Decision> {
    const icon = TYPE_ICONS[c.issueType];
    return select<Decision>({
      message: `#${c.number} → ${icon} ${c.issueType} (${c.confidence.toFixed(2)})`,
      choices: [
        { name: 'Keep classification', value: 'keep' },
        { name: 'Override type', value: 'override' },
        { name: 'Skip for now', value: 'skip' },
        { name: 'Stop reviewing', value: 'stop' },
      ],
    });
  }

  private selectType(current: string): Promise<'bug' | 'feature' | 'question' | 'other'> {
    type T = 'bug' | 'feature' | 'question' | 'other';
    const all: { name: string; value: T }[] = [
      { name: `${TYPE_ICONS.bug} bug`, value: 'bug' },
      { name: `${TYPE_ICONS.feature} feature`, value: 'feature' },
      { name: `${TYPE_ICONS.question} question`, value: 'question' },
      { name: `${TYPE_ICONS.other} other`, value: 'other' },
    ];
    return select<T>({
      message: 'Correct type:',
      choices: all.filter(c => c.value !== current),
    });
  }
}

function renderClassification(c: BugClassification, index: number, total: number): string {
  const icon = TYPE_ICONS[c.issueType];
  const lines = [
    '',
    chalk.bold(`ISSUE ${index + 1} of ${total} ${'─'.repeat(40)}`),
    '',
    `  #${c.number}  ${c.title}`,
    `  Type:       ${icon} ${chalk.yellow(c.issueType)} (confidence ${c.confidence.toFixed(2)})`,
    `  Reason:     ${c.reason}`,
    '',
  ];
  return lines.join('\n');
}
