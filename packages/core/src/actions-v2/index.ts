/**
 * Public entry point for the data-driven action runtime. Imported via
 * `@cezar/core` once exported from the package root in src/index.ts.
 */
export type { ActionDef, ActionTrigger, ActionRunResult } from './action.js';
export type { ActionTarget, RunActionDeps } from './runner.js';
export { runAction } from './runner.js';
export {
  EFFECT_REGISTRY,
  ALL_EFFECT_NAMES,
  executeEffect,
  effectsAsAnthropicTools,
  type EffectDef,
  type EffectCall,
  type EffectContext,
  type EffectName,
} from './effects.js';
