import ora from 'ora';
import chalk from 'chalk';
import type { Config } from '../models/config.model.js';
import { IssueStore } from '../store/store.js';
import { GitHubService } from '../services/github.service.js';
import { LLMService } from '../services/llm.service.js';

interface InitOptions {
  owner?: string;
  repo?: string;
  token?: string;
  includeClosed?: boolean;
  digest?: boolean;
  force?: boolean;
}

export async function initCommand(opts: InitOptions, config: Config): Promise<void> {
  const owner = opts.owner || config.github.owner;
  const repo = opts.repo || config.github.repo;

  if (!owner || !repo) {
    console.error(chalk.red('Missing --owner and --repo. Provide via CLI flags or .issuemanagerrc.json'));
    process.exit(1);
  }

  // Merge CLI overrides into config
  if (opts.token) config.github.token = opts.token;
  config.github.owner = owner;
  config.github.repo = repo;

  // Check if store already exists
  if (!opts.force) {
    const existing = await IssueStore.loadOrNull(config.store.path);
    if (existing) {
      console.error(chalk.yellow('Store already exists. Use --force to reinitialize.'));
      process.exit(1);
    }
  }

  // Fetch issues
  const spinner = ora('Fetching issues from GitHub...').start();
  const github = new GitHubService(config);
  const includeClosed = opts.includeClosed ?? config.sync.includeClosed;

  let issues;
  try {
    issues = await github.fetchAllIssues(includeClosed);
    spinner.succeed(`Fetched ${issues.length} issues from ${owner}/${repo}`);
  } catch (error) {
    spinner.fail('Failed to fetch issues');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }

  // Initialize store and upsert issues
  const store = await IssueStore.init(config.store.path, { owner, repo });
  let created = 0;
  for (const issue of issues) {
    const result = store.upsertIssue(issue);
    if (result.action === 'created') created++;
  }
  store.updateMeta({
    lastSyncedAt: new Date().toISOString(),
    totalFetched: issues.length,
  });
  await store.save();

  console.log(chalk.dim(`  ${created} issues stored`));

  // Generate digests
  if (opts.digest !== false) {
    const digestSpinner = ora('Generating digests...').start();
    try {
      const llm = new LLMService(config);
      const toDigest = store.getIssues({ hasDigest: false });
      const digests = await llm.generateDigests(
        toDigest.map(i => ({ number: i.number, title: i.title, body: i.body })),
        config.sync.digestBatchSize,
      );

      let digestCount = 0;
      for (const [number, digest] of digests) {
        store.setDigest(number, digest);
        digestCount++;
      }
      await store.save();

      // Count categories
      const allDigested = store.getIssues({ hasDigest: true });
      const categories = new Map<string, number>();
      for (const issue of allDigested) {
        const cat = issue.digest!.category;
        categories.set(cat, (categories.get(cat) ?? 0) + 1);
      }
      const catSummary = [...categories.entries()]
        .map(([cat, count]) => `${count} ${cat}s`)
        .join(' · ');

      digestSpinner.succeed(`Digested ${digestCount}/${toDigest.length} issues`);
      if (catSummary) {
        console.log(chalk.dim(`  Categories: ${catSummary}`));
      }
    } catch (error) {
      digestSpinner.warn('Digest generation failed (partial results saved)');
      console.error(chalk.yellow((error as Error).message));
      await store.save();
      process.exit(2);
    }
  }

  console.log(chalk.green(`\nStore initialized at ${config.store.path}/store.json`));
  console.log(chalk.dim("Next: run 'issue-manager' to open the action menu"));
}
