import chalk from 'chalk';
import { emitKeypressEvents } from 'node:readline';
import type { Ora } from 'ora';
import type { AgentEvent } from './agent-session.js';

/**
 * Toggleable live-trace of agent activity. While active, pressing Ctrl+O
 * flips verbose mode on/off. When on, every agent text/tool-call/tool-result
 * is streamed to stdout with truncation. When off, only the owning spinner
 * is visible.
 *
 * Only install once per autofix run; uninstall on completion (or crash) so
 * raw mode is restored for later inquirer prompts.
 */
class VerboseToggle {
  private enabled = false;
  private active = false;
  private keypressHandler?: (str: string, key: Key) => void;
  private spinner: Ora | null = null;
  private currentStage = '';

  install(spinner: Ora | null): void {
    if (this.active) return;
    if (!process.stdin.isTTY) return;
    this.active = true;
    this.spinner = spinner;

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.keypressHandler = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        this.uninstall();
        process.exit(130);
      }
      if (key.ctrl && key.name === 'o') {
        this.toggle();
      }
    };
    process.stdin.on('keypress', this.keypressHandler);

    this.writeLine(chalk.dim('Press Ctrl+O at any time to toggle verbose agent trace'));
  }

  uninstall(): void {
    if (!this.active) return;
    this.active = false;
    if (this.keypressHandler) {
      process.stdin.off('keypress', this.keypressHandler);
      this.keypressHandler = undefined;
    }
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    process.stdin.pause();
    this.spinner = null;
  }

  setStage(stage: string): void {
    this.currentStage = stage;
    if (this.spinner) this.spinner.text = stage;
  }

  isEnabled(): boolean { return this.enabled; }

  /** Called by the agent-session for every AgentEvent. Prints only when enabled. */
  onAgentEvent(evt: AgentEvent): void {
    if (!this.enabled) return;
    const line = formatEvent(evt);
    if (line) this.writeLine(line);
  }

  private toggle(): void {
    this.enabled = !this.enabled;
    if (this.enabled) {
      if (this.spinner) this.spinner.stop();
      this.writeLine(chalk.yellow.bold('  🔊 verbose ON — streaming agent events'));
    } else {
      this.writeLine(chalk.dim.bold('  🔇 verbose OFF'));
      if (this.spinner && this.currentStage) this.spinner.start(this.currentStage);
    }
  }

  private writeLine(line: string): void {
    if (this.spinner && this.spinner.isSpinning) {
      this.spinner.clear();
      process.stdout.write(`${line}\n`);
      this.spinner.render();
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}

interface Key {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

function formatEvent(evt: AgentEvent): string | null {
  switch (evt.type) {
    case 'text': {
      const trimmed = evt.text.trim();
      if (!trimmed) return null;
      const snippet = truncate(trimmed, 400);
      return `${chalk.cyan('  ▸ say ')} ${snippet}`;
    }
    case 'tool': {
      return `${chalk.magenta('  ▸ tool')} ${chalk.bold(evt.tool)} ${chalk.dim(formatInput(evt.input))}`;
    }
    case 'tool-result': {
      const snippet = truncate(evt.result, 400);
      const status = evt.isError ? chalk.red('ERR') : chalk.green('ok ');
      return `${chalk.magenta('  ◂ result')} ${status} ${chalk.dim(snippet)}`;
    }
    case 'turn-end':
      return chalk.dim(`  · turn end — ${evt.tokensUsed.toLocaleString()} tokens used so far`);
    case 'budget-exceeded':
      return chalk.red.bold(`  ✗ token budget exceeded: ${evt.used.toLocaleString()} / ${evt.limit.toLocaleString()}`);
    default:
      return null;
  }
}

function formatInput(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  try {
    const str = JSON.stringify(input);
    return truncate(str, 200);
  } catch {
    return '[unserializable]';
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}… ${chalk.dim(`(+${str.length - max} chars)`)}`;
}

export const verboseToggle = new VerboseToggle();
