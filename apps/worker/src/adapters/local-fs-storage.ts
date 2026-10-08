/**
 * 開発用 storage adapter（Cloud Storage の代替）。STORAGE_DIR 配下に保存し、web は署名付き URL 経由でのみ配信する。
 * key はアプリが生成した値のみ（利用者入力を含めない）だが、念のため path traversal を拒否する。
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AdapterError, type StorageAdapter, type StoredObject } from '../ports';

export class LocalFsStorage implements StorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new AdapterError('invalid storage key', false, 'STORAGE_KEY_INVALID');
    return full;
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathOf(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, bytes, { mode: 0o600 });
      await rename(tmp, path);
    } catch (error) {
      throw new AdapterError(`storage put failed: ${String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    }
  }

  async get(key: string): Promise<StoredObject> {
    try {
      return { bytes: await readFile(this.pathOf(key)) };
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(`storage get failed: ${String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    }
  }
}
