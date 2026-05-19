export type SkillTag =
  | 'DUPLICATES'
  | 'LOG_ANALYZER'
  | 'SEMANTIC_SEARCH'
  | 'LINT_MASTER'
  | 'BUG_DETECTOR'
  | 'PRIORITY'
  | 'AUTO_LABEL';

export type FindingBody =
  | { kind: 'dup'; dupNumber: number }
  | { kind: 'log'; pattern: string; clusters: number }
  | { kind: 'semantic'; deployment: string; note: string }
  | { kind: 'lint'; file: string; line: number; from: string; to: string }
  | { kind: 'bug'; note: string }
  | { kind: 'priority'; value: 'P0' | 'P1' | 'P2' | 'P3'; note: string }
  | { kind: 'label'; labels: string[] };

export type Finding = {
  id: string;
  /** Real action name from the actions table — used by the dynamic skill filter. */
  actionName: string;
  /** Visual-only tag (color/icon). Derived from actionName; kept as enum so the
   *  SKILL_STYLE palette stays type-safe. */
  skill: SkillTag;
  body: FindingBody;
  confidence: number;
};

export type DecisionItem = {
  kind: 'decision';
  id: string;
  issueNumber: number;
  issueTitle: string;
  findings: Finding[];
};

export type PrItem = {
  kind: 'pr';
  id: string;
  prNumber: number;
  title: string;
  ageMin: number;
  agent: string;
};

export type PausedItem = {
  kind: 'paused';
  id: string;
  runNumber: number;
  workflow: string;
  step: string;
  ageMin: number;
};

export type FailedItem = {
  kind: 'failed';
  id: string;
  runNumber: number;
  workflow: string;
  reason: string;
  ageMin: number;
};

export type InboxItem = DecisionItem | PrItem | PausedItem | FailedItem;

export const MOCK_ITEMS: InboxItem[] = [
  {
    kind: 'failed',
    id: 'r-1704',
    runNumber: 1704,
    workflow: 'autofix',
    reason: 'root-cause step failed: rate-limit on Anthropic API',
    ageMin: 1440,
  },
  {
    kind: 'paused',
    id: 'r-1874',
    runNumber: 1874,
    workflow: 'autofix',
    step: 'confirm-fix-plan',
    ageMin: 480,
  },
  {
    kind: 'pr',
    id: 'pr-1832',
    prNumber: 1832,
    title: 'Fix null-deref in OrderService.cancelOrder()',
    agent: 'autofix',
    ageMin: 130,
  },
  {
    kind: 'decision',
    id: 'd-1402',
    issueNumber: 1402,
    issueTitle: 'Unexpected latency in auth middleware',
    findings: [
      {
        id: 'f-1402-1',
        actionName: 'duplicates',
        skill: 'DUPLICATES',
        body: { kind: 'dup', dupNumber: 1388 },
        confidence: 94,
      },
      {
        id: 'f-1402-2',
        actionName: 'log-analyzer',
        skill: 'LOG_ANALYZER',
        body: { kind: 'log', pattern: 'AuthTokenExpiring', clusters: 14 },
        confidence: 88,
      },
    ],
  },
  {
    kind: 'decision',
    id: 'd-1410',
    issueNumber: 1410,
    issueTitle: 'Database connection pool exhaustion on prod-west',
    findings: [
      {
        id: 'f-1410-1',
        actionName: 'semantic-search',
        skill: 'SEMANTIC_SEARCH',
        body: {
          kind: 'semantic',
          deployment: 'v2.4.1-rc',
          note: 'Root cause likely related to recent deployment',
        },
        confidence: 76,
      },
      {
        id: 'f-1410-2',
        actionName: 'bug-detector',
        skill: 'BUG_DETECTOR',
        body: { kind: 'bug', note: 'Classified as runtime bug · affects production' },
        confidence: 91,
      },
      {
        id: 'f-1410-3',
        actionName: 'priority',
        skill: 'PRIORITY',
        body: { kind: 'priority', value: 'P1', note: 'Customer-facing outage signal' },
        confidence: 89,
      },
    ],
  },
  {
    kind: 'decision',
    id: 'd-1395',
    issueNumber: 1395,
    issueTitle: 'Spelling error in documentation landing page',
    findings: [
      {
        id: 'f-1395-1',
        actionName: 'lint-master',
        skill: 'LINT_MASTER',
        body: { kind: 'lint', file: '/docs/intro.md', line: 42, from: 'recieve', to: 'receive' },
        confidence: 100,
      },
    ],
  },
  {
    kind: 'decision',
    id: 'd-1421',
    issueNumber: 1421,
    issueTitle: 'Memory leak after long-running sync jobs',
    findings: [
      {
        id: 'f-1421-1',
        actionName: 'auto-label',
        skill: 'AUTO_LABEL',
        body: { kind: 'label', labels: ['performance', 'memory'] },
        confidence: 84,
      },
      {
        id: 'f-1421-2',
        actionName: 'priority',
        skill: 'PRIORITY',
        body: { kind: 'priority', value: 'P2', note: 'Degrades over 24h+ uptime' },
        confidence: 71,
      },
    ],
  },
  {
    kind: 'decision',
    id: 'd-1438',
    issueNumber: 1438,
    issueTitle: 'Webhook deliveries dropping intermittently',
    findings: [
      {
        id: 'f-1438-1',
        actionName: 'duplicates',
        skill: 'DUPLICATES',
        body: { kind: 'dup', dupNumber: 1290 },
        confidence: 81,
      },
    ],
  },
];

export const HEALTH_ALERTS: { id: string; text: string; severity: 'warn' | 'error' }[] = [
  { id: 'h-1', text: 'Webhook secret missing — incoming events ignored', severity: 'warn' },
  { id: 'h-2', text: 'Runner offline (last seen 2h ago)', severity: 'warn' },
];
