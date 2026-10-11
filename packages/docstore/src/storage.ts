/**
 * 帳票ファイルの保存先（CHG-006）。worker が書き、web の配信 route（署名付き URL の検証後）が読む。
 *   STORAGE_BUCKET あり → Cloud Storage（公開禁止バケット）
 *   なし              → ローカルディスク（開発用、STORAGE_DIR、既定 ~/.inspexor-storage）
 * key はアプリが生成した値のみ（利用者入力を含めない）。念のため path traversal を拒否する。
 */
import { createHash } from 'node:crypto';
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

/** 保存済み object の情報。md5Base64 は保存先が計算した内容の MD5（base64）。無い場合は null */
export interface StoredObjectInfo {
  readonly sizeBytes: number;
  readonly md5Base64: string | null;
}

export interface StorageAdapter {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<StoredObject>;
  /** 内容を読まずに、保存先が計算したサイズと MD5 を返す（保存直後の照合用。g25a） */
  stat(key: string): Promise<StoredObjectInfo>;
}

/** 照合用の MD5（base64。Cloud Storage の md5Hash と同じ形式） */
export function md5Base64(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('base64');
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

  async stat(key: string): Promise<StoredObjectInfo> {
    const { bytes } = await this.get(key);
    return { sizeBytes: bytes.byteLength, md5Base64: md5Base64(bytes) };
  }
}

function gcsError(error: unknown, op: string): StorageError {
  const code = Number((error as { code?: unknown } | null)?.code);
  if (code === 404) return new StorageError(`gcs ${op}: not found`, false, 'NOT_FOUND');
  const retryable = !Number.isFinite(code) || code === 408 || code === 429 || code >= 500;
  return new StorageError(`gcs ${op} failed: ${error instanceof Error ? error.message : String(error)}`, retryable, 'DEPENDENCY_UNAVAILABLE');
}

export interface GcsStorageOptions {
  /** JSON API の接続先（試験用。既定 https://storage.googleapis.com） */
  readonly apiBase?: string;
  /** 認証ヘッダ（試験用。既定は SDK の認証＝ADC。GOOGLE_CLOUD_QUOTA_PROJECT も反映される） */
  readonly authHeaders?: () => Promise<Record<string, string>>;
  /** 読出し1回の打ち切り（ms。既定 15 秒） */
  readonly requestTimeoutMs?: number;
  /** 読出しの試行回数（既定 3 回。間隔 0.5 秒・1 秒） */
  readonly attempts?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GcsStorage implements StorageAdapter {
  /**
   * 保存（put）は SDK。1回の HTTP 要求は 30 秒で打ち切り、再試行は最大3回・合計60秒（既定は合計600秒で、障害時に job が長く止まるため）。
   * 読出し（get・stat）は SDK を使わず、Node 標準の fetch で JSON API を直接呼ぶ（g25a）。
   *   g24b の計測で SDK の download() だけが 30 秒の打ち切り待ちを繰り返し 1.5〜97 秒かかったため。
   *   1回 15 秒で打ち切り、最大3回まで再試行。それでも失敗したら DEPENDENCY_UNAVAILABLE（retry 対象）として job の再試行に任せる。
   */
  private readonly storage = new Storage({ timeout: 30_000, retryOptions: { maxRetries: 3, maxRetryDelay: 8, totalTimeout: 60 } });
  private readonly apiBase: string;
  private readonly authHeaders: () => Promise<Record<string, string>>;
  private readonly requestTimeoutMs: number;
  private readonly attempts: number;

  constructor(
    private readonly bucket: string,
    options: GcsStorageOptions = {},
  ) {
    this.apiBase = (options.apiBase ?? 'https://storage.googleapis.com').replace(/\/+$/, '');
    this.authHeaders = options.authHeaders ?? (async () => ({ ...((await this.storage.authClient.getRequestHeaders()) as Record<string, string>) }));
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.attempts = Math.max(1, options.attempts ?? 3);
  }

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    assertKey(key);
    try {
      // 同じ key は同じ内容（帳票 job ごとに一意の key）。resumable は小さい PDF には不要
      await this.storage.bucket(this.bucket).file(key).save(bytes, { contentType: mimeType, resumable: false });
    } catch (error) {
      throw gcsError(error, 'put');
    }
  }

  private objectUrl(key: string, query: string): string {
    return `${this.apiBase}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?${query}`;
  }

  /** JSON API を呼ぶ。404 は NOT_FOUND、408/429/5xx・通信失敗・打ち切りは再試行 */
  private async request(key: string, query: string, op: string): Promise<Response> {
    let last: StorageError | null = null;
    for (let i = 0; i < this.attempts; i += 1) {
      if (i > 0) await sleep(500 * 2 ** (i - 1));
      let res: Response;
      try {
        const headers = await this.authHeaders();
        res = await fetch(this.objectUrl(key, query), { headers, signal: AbortSignal.timeout(this.requestTimeoutMs) });
      } catch (error) {
        const timedOut = (error as { name?: string } | null)?.name === 'TimeoutError';
        last = new StorageError(`gcs ${op} failed: ${timedOut ? `timeout ${this.requestTimeoutMs}ms` : error instanceof Error ? error.message : String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
        continue;
      }
      if (res.ok) return res;
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 404) throw new StorageError(`gcs ${op}: not found`, false, 'NOT_FOUND');
      const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
      last = new StorageError(`gcs ${op} failed: HTTP ${res.status}`, retryable, 'DEPENDENCY_UNAVAILABLE');
      if (!retryable) throw last;
    }
    throw last ?? new StorageError(`gcs ${op} failed`, true, 'DEPENDENCY_UNAVAILABLE');
  }

  async get(key: string): Promise<StoredObject> {
    assertKey(key);
    // 本文の受信も打ち切りの対象（request の signal が本文の読込まで有効）。途中で切れたら1回だけやり直す
    for (let i = 0; ; i += 1) {
      const res = await this.request(key, 'alt=media', 'get');
      try {
        return { bytes: Buffer.from(await res.arrayBuffer()) };
      } catch (error) {
        if (i >= 1) throw new StorageError(`gcs get failed: ${error instanceof Error ? error.message : String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
      }
    }
  }

  async stat(key: string): Promise<StoredObjectInfo> {
    assertKey(key);
    const res = await this.request(key, 'fields=size%2Cmd5Hash', 'stat');
    let meta: { size?: unknown; md5Hash?: unknown };
    try {
      meta = (await res.json()) as { size?: unknown; md5Hash?: unknown };
    } catch (error) {
      throw new StorageError(`gcs stat failed: ${error instanceof Error ? error.message : String(error)}`, true, 'DEPENDENCY_UNAVAILABLE');
    }
    const size = Number(meta.size);
    if (!Number.isFinite(size)) throw new StorageError('gcs stat failed: size がありません', true, 'DEPENDENCY_UNAVAILABLE');
    return { sizeBytes: size, md5Base64: typeof meta.md5Hash === 'string' ? meta.md5Hash : null };
  }
}

const cache = new Map<string, StorageAdapter>();

/** 環境変数から保存先を決める（web・worker 共通）。認証情報を使い回すため、同じ保存先は process 内で1つにする */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const bucket = env['STORAGE_BUCKET'];
  const id = bucket ? `gcs:${bucket}` : `fs:${env['STORAGE_DIR'] ?? join(homedir(), '.inspexor-storage')}`;
  let adapter = cache.get(id);
  if (adapter === undefined) {
    adapter = bucket ? new GcsStorage(bucket) : new LocalFsStorage(env['STORAGE_DIR'] ?? join(homedir(), '.inspexor-storage'));
    cache.set(id, adapter);
  }
  return adapter;
}
