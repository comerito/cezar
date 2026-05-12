import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '@cezar/core';
import type { Database } from './supabase/types';
import { loadWorkflowBindings, loadWorkflowSettings } from './workflow-config';

/**
 * Loads a merged config: cosmiconfig defaults + workspace JSONB overrides.
 * The workspace config (saved via Settings pane) takes precedence.
 */
export async function loadWorkspaceConfig(
  workspaceId: string,
  supabase: SupabaseClient<Database>,
  overrides?: { githubToken?: string; repoOwner?: string; repoName?: string },
): Promise<Config> {
  const core = await import('@cezar/core');

  let baseConfig: Config;
  try {
    baseConfig = await core.loadConfig();
  } catch {
    baseConfig = await core.loadConfig({
      github: {
        owner: overrides?.repoOwner ?? '',
        repo: overrides?.repoName ?? '',
        token: '',
      },
    });
  }

  const { data: ws } = await supabase
    .from('workspaces')
    .select('config, repo_owner, repo_name')
    .eq('id', workspaceId)
    .single();

  const wsConfig = (ws?.config ?? {}) as Record<string, unknown>;

  if (overrides?.repoOwner) baseConfig.github.owner = overrides.repoOwner;
  if (overrides?.repoName) baseConfig.github.repo = overrides.repoName;
  if (overrides?.githubToken) baseConfig.github.token = overrides.githubToken;
  if (ws?.repo_owner && !baseConfig.github.owner) baseConfig.github.owner = ws.repo_owner;
  if (ws?.repo_name && !baseConfig.github.repo) baseConfig.github.repo = ws.repo_name;

  const wSync = (wsConfig.sync ?? {}) as Record<string, unknown>;
  if (Object.keys(wSync).length > 0) {
    Object.assign(baseConfig.sync, wSync);
  }

  const wAutofix = (wsConfig.autofix ?? {}) as Record<string, unknown>;
  if (Object.keys(wAutofix).length > 0) {
    const models = wAutofix.models as Record<string, unknown> | undefined;
    const maxTurns = wAutofix.maxTurns as Record<string, unknown> | undefined;
    const { models: _m, maxTurns: _t, ...rest } = wAutofix;
    Object.assign(baseConfig.autofix, rest);
    if (models && Object.keys(models).length > 0) {
      Object.assign(baseConfig.autofix.models, models);
    }
    if (maxTurns && Object.keys(maxTurns).length > 0) {
      Object.assign(baseConfig.autofix.maxTurns, maxTurns);
    }
  }

  // Inject the GUI-configured workflow bindings/settings so a binding actually
  // affects autofix runs (the core orchestrator reads `config.workflow.bindings`).
  // `useEngine` (Phase 3a) flips the orchestrator onto the declarative workflow
  // engine — defaults off; settable via the workspace's `config.workflow.useEngine`
  // JSONB or the CEZAR_USE_WORKFLOW_ENGINE env var (escape hatch for ops).
  const wWorkflow = (wsConfig.workflow ?? {}) as Record<string, unknown>;
  const useEngine =
    process.env.CEZAR_USE_WORKFLOW_ENGINE === 'true' || wWorkflow.useEngine === true;
  baseConfig.workflow = {
    useEngine,
    bindings: await loadWorkflowBindings(workspaceId, supabase, baseConfig.github.repo || undefined),
    settings: await loadWorkflowSettings(workspaceId, supabase),
  };

  return baseConfig;
}
