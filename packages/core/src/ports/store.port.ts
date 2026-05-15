import type { Store } from '../store/store.model.js';

/**
 * Abstraction over store persistence. The CLI reads/writes a local JSON file;
 * the GUI would persist to Supabase. Consumers call load/save and optionally
 * subscribe to external changes.
 */
export interface StorePort {
  load(): Promise<Store>;
  save(store: Store): Promise<void>;
  onChange?(callback: (store: Store) => void): () => void;
}
