/**
 * 帳票ファイルの保存先（CHG-006）。worker が書き、web の配信 route（署名付き URL の検証後）が読む。
 *   STORAGE_BUCKET あり → Cloud Storage（公開禁止バケット）
 *   なし              → ローカルディスク（開発用、STORAGE_DIR、既定 ~/.inspexor-storage）
 * key はアプリが生成した値のみ（利用者入力を含めない）。念のため path traversal を拒否する。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Storage } from '@google-cloud/storage';

export class StorageError extends Error {
  constructor(
    message: string,
    /** network/408/429/5xx 相当なら true（retry 対象） */
    readonly retryable: boolean,
    readonly code: 'STORAGE_KEY_INVALID' | 'NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StoredObject {
  readonly bytes: Buffer;
}

export interface StorageAdapter {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
}

function assertKey(key: string): void {
  if (key.length === 0 || key.length > 1024 || key.startsWith('/') || key.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new StorageError('invalid storage key', false, 'STORAGE_KEY_INVALID');
  }
}

export class LocalFsStorage implements StorageAdapter {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    assertKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new StorageError('invalid storage key', false, 'STORAGE_KEY_INVALID');
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
      throw new StorageError(`storage put failed: ${String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    }
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.pathOf(key);
    try {
      return { bytes: await readFile(path) };
    } catch (error) {
      const notFound = (error as { code?: string }).code === 'ENOENT';
      throw new StorageError(`storage get failed: ${String(error)}`, !notFound, notFound ? 'NOT_FOUND' : 'DEPENDENCY_UNAVAILABLE');
    }
  }
}

function gcsError(error: unknown, op: string): StorageError {
  const code = Number((error as { code?: unknown } | null)?.code);
  if (code === 404) return new StorageError(`gcs ${op}: not found`, false, 'NOT_FOUND');
  const retryable = !Number.isFinite(code) || code === 408 || code === 429 || code >= 500;
  return new StorageError(`gcs ${op} failed: ${error instanceof Error ? error.message : String(error)}`, retryable, 'DEPENDENCY_UNAVAILABLE');
}

export class GcsStorage implements StorageAdapter {
  private readonly storage = new Storage();

  constructor(private readonly bucket: string) {}

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    assertKey(key);
    try {
      // 同じ key は同じ内容（帳票 job ごとに一意の key）。resumable は小さい PDF には不要
      await this.storage.bucket(this.bucket).file(key).save(bytes, { contentType: mimeType, resumable: false });
    } catch (error) {
      throw gcsError(error, 'put');
    }
  }

  async get(key: string): Promise<StoredObject> {
    assertKey(key);
    try {
      const [bytes] = await this.storage.bucket(this.bucket).file(key).download();
      return { bytes };
    } catch (error) {
      throw gcsError(error, 'get');
    }
  }
}

/** 環境変数から保存先を決める（web・worker 共通） */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const bucket = env['STORAGE_BUCKET'];
  if (bucket) return new GcsStorage(bucket);
  return new LocalFsStorage(env['STORAGE_DIR'] ?? join(homedir(), '.inspexor-storage'));
}
