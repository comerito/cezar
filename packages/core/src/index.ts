// Store
export {
  StoreSchema,
  StoredIssueSchema,
  IssueAnalysisSchema,
  IssueDigestSchema,
  StoredCommentSchema,
  StoreMetaSchema,
  type Store,
  type StoredIssue,
  type StoredComment,
  type IssueAnalysis,
  type IssueDigest,
  type StoreMeta,
} from './store/store.model.js';
export { IssueStore, type IssueFilter } from './store/store.js';

// Config
export {
  ConfigSchema,
  type Config,
} from './config/config.model.js';
export { loadConfig } from './config/loader.js';

// Services
export {
  GitHubService,
  summarizeCi,
  parseCheckRunUrl,
  type RawIssue,
  type TimelineCrossReference,
  type CheckRunSummary,
  type CiOverall,
  type CiSummary,
} from './services/github.service.js';
export {
  LLMService,
  DuplicateResponseSchema,
  type DuplicateMatch,
} from './services/llm.service.js';
export {
  formatAuditComment,
  withAuditFooter,
  postAuditComment,
} from './services/audit.js';

// Utils
export { chunkArray } from './utils/chunker.js';
export { contentHash } from './utils/hash.js';
export { formatCommentsForPrompt } from './utils/comment-formatter.js';

// Ports
export type { StorePort } from './ports/store.port.js';
export type { EventPort, AgentEvent } from './ports/event.port.js';
export type { ConfigPort } from './ports/config.port.js';
export type {
  ConfirmationPort,
  PreflightSummary,
  RootCausePrompt,
} from './ports/confirmation.port.js';

// Actions infrastructure
export type {
  ActionDefinition,
  ActionContext,
  ActionGroup,
} from './actions/action.interface.js';
export { actionRegistry } from './actions/registry.js';

// Action runners + prompts
export * from './actions/auto-label/runner.js';
export * from './actions/auto-label/prompt.js';
export * from './actions/bug-detector/runner.js';
export * from './actions/bug-detector/prompt.js';
export * from './actions/categorize/runner.js';
export * from './actions/categorize/prompt.js';
export * from './actions/claim-detector/runner.js';
export * from './actions/claim-detector/patterns.js';
export * from './actions/contributor-welcome/runner.js';
export * from './actions/contributor-welcome/prompt.js';
export * from './actions/done-detector/runner.js';
export * from './actions/done-detector/prompt.js';
export * from './actions/duplicates/runner.js';
export * from './actions/duplicates/prompt.js';
export * from './actions/good-first-issue/runner.js';
export * from './actions/good-first-issue/prompt.js';
export * from './actions/issue-check/runner.js';
export * from './actions/issue-check/prompt.js';
export * from './actions/milestone-planner/runner.js';
export * from './actions/milestone-planner/prompt.js';
export * from './actions/missing-info/runner.js';
export * from './actions/missing-info/prompt.js';
export * from './actions/needs-response/runner.js';
export * from './actions/needs-response/prompt.js';
export * from './actions/priority/runner.js';
export * from './actions/priority/prompt.js';
export * from './actions/quality/runner.js';
export * from './actions/quality/prompt.js';
export * from './actions/recurring-questions/runner.js';
export * from './actions/recurring-questions/prompt.js';
export * from './actions/release-notes/runner.js';
export * from './actions/release-notes/prompt.js';
export * from './actions/security/runner.js';
export * from './actions/security/prompt.js';
export * from './actions/stale/runner.js';
export * from './actions/stale/prompt.js';

// Autofix internals (orchestrator + agent session). The CLI still owns the
// terminal-facing AutofixRunner + verbose toggle.
export * from './actions/autofix/orchestrator.js';
export * from './actions/autofix/agent-session.js';
export * from './actions/autofix/token-budget.js';
export * from './actions/autofix/worktree.js';
export * from './actions/autofix/skills.js';
export * from './actions/autofix/prompts/analyzer.js';
export * from './actions/autofix/prompts/fixer.js';
export * from './actions/autofix/prompts/reviewer.js';
export * from './actions/autofix/ci-attribution.js';

// Pipeline
export * from './pipeline/index.js';
