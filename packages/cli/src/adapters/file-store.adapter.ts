import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StoreSchema, type Store, type StorePort } from '@cezar/core';

/**
 * Default StorePort impl backed by a local JSON file (`.issue-store/store.json`).
 * Writes are atomic via temp-file rename.
 */
export class FileStoreAdapter implements StorePort {
  private readonly filePath: string;

  constructor(storePath: string) {
    this.filePath = join(storePath, 'store.json');
  }

  async load(): Promise<Store> {
    const raw = await readFile(this.filePath, 'utf-8');
    return StoreSchema.parse(JSON.parse(raw));
  }

  async save(store: Store): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    try {
      await rename(tmpPath, this.filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }
}
