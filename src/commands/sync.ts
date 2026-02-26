import chalk from 'chalk';
import ora from 'ora';
import type { Config } from '../models/config.model.js';
import { IssueStore } from '../store/store.js';
import { GitHubService } from '../services/github.service.js';
import { LLMService } from '../services/llm.service.js';

interface SyncOptions {
  token?: string;
  includeClosed?: boolean;
}

export async function syncCommand(opts: SyncOptions, config: Config): Promise<void> {
  if (opts.token) config.github.token = opts.token;

  const store = await IssueStore.loadOrNull(config.store.path);
  if (!store) {
    console.error(chalk.red("Store not found. Run 'cezar init' first."));
    process.exit(1);
  }

  const meta = store.getMeta();
  config.github.owner = meta.owner;
  config.github.repo = meta.repo;

  const spinner = ora('Syncing with GitHub...').start();
  const github = new GitHubService(config);
  const includeClosed = opts.includeClosed ?? config.sync.includeClosed;

  let issues;
  try {
    if (meta.lastSyncedAt) {
      issues = await github.fetchIssuesSince(meta.lastSyncedAt, includeClosed);
    } else {
      issues = await github.fetchAllIssues(includeClosed);
    }
  } catch (error) {
    spinner.fail('Failed to fetch issues');
    console.error(chalk.red((error as Error).message));
    process.exit(1);
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const issue of issues) {
    const result = store.upsertIssue(issue);
    if (result.action === 'created') created++;
    else if (result.action === 'updated') updated++;
    else unchanged++;
  }

  store.updateMeta({ lastSyncedAt: new Date().toISOString() });
  await store.save();

  spinner.succeed(`Fetched ${issues.length} issues — ${created} new, ${updated} updated`);

  // Re-digest any issues that need it
  const needsDigest = store.getIssues({ hasDigest: false });
  if (needsDigest.length > 0) {
    const digestSpinner = ora(`Generating digests for ${needsDigest.length} issues...`).start();
    try {
      const llm = new LLMService(config);
      const digests = await llm.generateDigests(
        needsDigest.map(i => ({ number: i.number, title: i.title, body: i.body })),
        config.sync.digestBatchSize,
      );

      let digestCount = 0;
      for (const [number, digest] of digests) {
        store.setDigest(number, digest);
        digestCount++;
      }
      await store.save();
      digestSpinner.succeed(`Re-digested ${digestCount} issues`);
    } catch (error) {
      digestSpinner.warn('Digest generation failed (partial results saved)');
      console.error(chalk.yellow((error as Error).message));
      await store.save();
      process.exit(2);
    }
  }

  // Summary
  const unanalyzed = store.getIssues({ state: 'open', hasDigest: true })
    .filter(i => i.analysis.duplicatesAnalyzedAt === null).length;
  if (unanalyzed > 0) {
    console.log(chalk.dim(`  ${unanalyzed} issues need duplicate check — run 'cezar run duplicates'`));
  }
}
