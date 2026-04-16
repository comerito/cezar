import type { IssueStore } from '../store/store.js';
import type { Config } from '../config/config.model.js';
import type { EventPort } from '../ports/event.port.js';
import { actionRegistry } from '../actions/registry.js';
import { getCloseFlaggedIssueNumbers } from './close-flag.js';

const CLOSE_DETECTION_ACTION_IDS = ['duplicates', 'done-detector'];
const ACT_PHASE_ACTION_IDS = ['autofix'];

export interface PipelineOptions {
  recheck?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  autofix?: boolean;
  apply?: boolean;
  maxIssues?: number;
  events?: EventPort;
}

export interface PipelineResult {
  phase1Actions: string[];
  phase2Actions: string[];
  phase3Actions: string[];
  closeFlaggedCount: number;
  errors: Array<{ actionId: string; error: Error }>;
}

export async function runPipeline(
  store: IssueStore,
  config: Config,
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const emit = (msg: string) => options.events?.lifecycle(msg);
  const allActions = actionRegistry.getAll();

  const phase1 = allActions.filter(a => CLOSE_DETECTION_ACTION_IDS.includes(a.id));
  const phase2 = allActions.filter(a =>
    !CLOSE_DETECTION_ACTION_IDS.includes(a.id) &&
    !ACT_PHASE_ACTION_IDS.includes(a.id),
  );
  const phase3 = allActions.filter(a => ACT_PHASE_ACTION_IDS.includes(a.id));

  const result: PipelineResult = {
    phase1Actions: [],
    phase2Actions: [],
    phase3Actions: [],
    closeFlaggedCount: 0,
    errors: [],
  };

  emit('── Phase 1: Close Detection ──');

  for (const action of phase1) {
    const availability = action.isAvailable(store);
    if (availability !== true) {
      emit(`Skipping ${action.label}: ${availability}`);
      continue;
    }

    emit(`Running ${action.icon}  ${action.label}...`);
    try {
      await action.run({
        store,
        config,
        interactive: false,
        options: {
          recheck: options.recheck ?? false,
          dryRun: options.dryRun ?? false,
        },
      });
      result.phase1Actions.push(action.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      emit(`Error in ${action.id}: ${err.message}`);
      result.errors.push({ actionId: action.id, error: err });
    }
  }

  const excludeIssues = getCloseFlaggedIssueNumbers(store);
  result.closeFlaggedCount = excludeIssues.size;

  if (excludeIssues.size > 0) {
    emit(`${excludeIssues.size} issue(s) flagged for closing — excluded from enrichment.`);
  }

  emit('── Phase 2: Enrichment ──');

  for (const action of phase2) {
    const availability = action.isAvailable(store);
    if (availability !== true) {
      emit(`Skipping ${action.label}: ${availability}`);
      continue;
    }

    emit(`Running ${action.icon}  ${action.label}...`);
    try {
      await action.run({
        store,
        config,
        interactive: false,
        options: {
          recheck: options.recheck ?? false,
          dryRun: options.dryRun ?? false,
          excludeIssues,
        },
      });
      result.phase2Actions.push(action.id);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      emit(`Error in ${action.id}: ${err.message}`);
      result.errors.push({ actionId: action.id, error: err });
    }
  }

  if (options.autofix && phase3.length > 0) {
    emit('── Phase 3: Act ──');

    for (const action of phase3) {
      const availability = action.isAvailable(store);
      if (availability !== true) {
        emit(`Skipping ${action.label}: ${availability}`);
        continue;
      }

      emit(`Running ${action.icon}  ${action.label}...`);
      try {
        await action.run({
          store,
          config,
          interactive: options.interactive ?? false,
          options: {
            recheck: options.recheck ?? false,
            dryRun: options.dryRun ?? false,
            apply: options.apply ?? false,
            maxIssues: options.maxIssues,
            excludeIssues,
          },
        });
        result.phase3Actions.push(action.id);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        emit(`Error in ${action.id}: ${err.message}`);
        result.errors.push({ actionId: action.id, error: err });
      }
    }
  }

  return result;
}
