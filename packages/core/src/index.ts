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
  type RawIssue,
  type TimelineCrossReference,
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
