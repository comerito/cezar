import 'dotenv/config';
import { cosmiconfig } from 'cosmiconfig';
import { ConfigSchema, type Config } from '../models/config.model.js';

export async function loadConfig(overrides: Partial<Config> = {}): Promise<Config> {
  const explorer = cosmiconfig('issuemanager');
  const result = await explorer.search();

  const raw = result?.config ?? {};

  // Merge env vars
  if (process.env.GITHUB_TOKEN) {
    raw.github = raw.github ?? {};
    raw.github.token = raw.github.token || process.env.GITHUB_TOKEN;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    raw.llm = raw.llm ?? {};
    raw.llm.apiKey = raw.llm.apiKey || process.env.ANTHROPIC_API_KEY;
  }

  // Merge CLI overrides
  const merged = deepMerge(raw, overrides);

  return ConfigSchema.parse(merged);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (val !== undefined && val !== null && val !== '') {
      if (typeof val === 'object' && !Array.isArray(val) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}
