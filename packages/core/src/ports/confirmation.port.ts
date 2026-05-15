/**
 * Summary of autofix preflight context shown to the user before the run begins.
 */
export interface PreflightSummary {
  repoRoot: string;
  baseBranch: string;
  mode: 'apply' | 'dry-run';
  maxAttemptsPerIssue: number;
  tokenBudgetPerAttempt: number;
  eligibleIssueCount: number;
}

/**
 * Root-cause gate payload. The CLI renders a terminal prompt; the GUI renders
 * a modal over a Supabase-backed channel.
 */
export interface RootCausePrompt {
  issueNumber: number;
  issueTitle: string;
  rootCause: string;
  confidence: number;
  evidence: string[];
}

/**
 * Abstraction over user confirmations. The CLI wraps @inquirer/prompts; the
 * GUI resolves promises via React modal interactions.
 */
export interface ConfirmationPort {
  /** Autofix preflight — show config summary, ask to proceed. */
  confirmPreflight(summary: PreflightSummary): Promise<boolean>;

  /** Root-cause approval gate — proceed to apply a fix or skip this issue. */
  confirmRootCause(prompt: RootCausePrompt): Promise<'proceed' | 'skip'>;

  /** Generic yes/no confirmation. */
  confirm(message: string): Promise<boolean>;
}
