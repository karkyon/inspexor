/**
 * 本番・開発用 DocStore（Cloud Firestore、Native mode）。
 * 認証は実行環境の既定（Cloud Run のサービスアカウント / Cloud Shell の gcloud 認証）。
 * FIRESTORE_EMULATOR_HOST が設定されていれば SDK が自動でエミュレータに接続する（結合試験）。
 */
import { Firestore, Timestamp, type DocumentData, type Query, type Transaction } from '@google-cloud/firestore';
import { assertCollectionPath, assertDocPath, DocStoreError, type Doc, type DocInput, type DocStore, type DocTransaction, type QuerySpec, type Snapshot } from './types';
import { normalizeDoc } from './values';
import { planQuery } from './query';

export interface FirestoreDocStoreOptions {
  readonly projectId?: string;
  /** 既定 '(default)' */
  readonly databaseId?: string;
}

function fromFirestore(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(fromFirestore);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fromFirestore(v);
    return out;
  }
  return value;
}

/** gRPC の状態コード → DocStoreError */
function mapError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 6) return new DocStoreError('ALREADY_EXISTS', message);
  if (code === 5) return new DocStoreError('NOT_FOUND', message);
  if (code === 9 && /index/i.test(message)) return new DocStoreError('INDEX_REQUIRED', message);
  if (code === 3) return new DocStoreError('INVALID', message);
  return error;
}

export class FirestoreDocStore implements DocStore {
  readonly db: Firestore;

  constructor(options: FirestoreDocStoreOptions = {}) {
    this.db = new Firestore({
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
      ...(options.databaseId !== undefined ? { databaseId: options.databaseId } : {}),
      ignoreUndefinedProperties: true,
    });
  }

  private buildQuery(collection: string, spec: QuerySpec): Query {
    assertCollectionPath(collection);
    const { filters } = planQuery(collection, spec);
    let q: Query = this.db.collection(collection);
    for (const f of filters) q = q.where(f.field, f.op, f.value);
    for (const o of spec.orderBy ?? []) q = q.orderBy(o.field, o.dir ?? 'asc');
    if (spec.limit !== undefined) q = q.limit(spec.limit);
    return q;
  }

  private snapshots<T>(docs: ReadonlyArray<{ id: string; ref: { path: string }; data(): DocumentData }>): Array<Snapshot<T>> {
    return docs.map((d) => ({ id: d.id, path: d.ref.path, data: fromFirestore(d.data()) as T }));
  }

  async get<T = Doc>(path: string): Promise<T | null> {
    assertDocPath(path);
    try {
      const snap = await this.db.doc(path).get();
      return snap.exists ? (fromFirestore(snap.data()) as T) : null;
    } catch (error) {
      throw mapError(error);
    }
  }

  async getMany<T = Doc>(paths: readonly string[]): Promise<Array<T | null>> {
    if (paths.length === 0) return [];
    paths.forEach(assertDocPath);
    try {
      const snaps = await this.db.getAll(...paths.map((p) => this.db.doc(p)));
      return snaps.map((s) => (s.exists ? (fromFirestore(s.data()) as T) : null));
    } catch (error) {
      throw mapError(error);
    }
  }

  async query<T = Doc>(collection: string, spec: QuerySpec = {}): Promise<Array<Snapshot<T>>> {
    try {
      const snap = await this.buildQuery(collection, spec).get();
      return this.snapshots<T>(snap.docs);
    } catch (error) {
      throw mapError(error);
    }
  }

  async count(collection: string, spec: QuerySpec = {}): Promise<number> {
    const { limit: _ignored, ...rest } = spec;
    try {
      const snap = await this.buildQuery(collection, rest).count().get();
      return snap.data().count;
    } catch (error) {
      throw mapError(error);
    }
  }

  async runTransaction<T>(work: (tx: DocTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.runTransaction(async (t: Transaction) => {
        const tx: DocTransaction = {
          get: async <R = Doc>(path: string): Promise<R | null> => {
            assertDocPath(path);
            const s = await t.get(this.db.doc(path));
            return s.exists ? (fromFirestore(s.data()) as R) : null;
          },
          getMany: async <R = Doc>(paths: readonly string[]): Promise<Array<R | null>> => {
            if (paths.length === 0) return [];
            paths.forEach(assertDocPath);
            const snaps = await t.getAll(...paths.map((p) => this.db.doc(p)));
            return snaps.map((s) => (s.exists ? (fromFirestore(s.data()) as R) : null));
          },
          query: async <R = Doc>(collection: string, spec: QuerySpec = {}): Promise<Array<Snapshot<R>>> => {
            const snap = await t.get(this.buildQuery(collection, spec));
            return this.snapshots<R>(snap.docs);
          },
          create: (path: string, data: DocInput) => {
            assertDocPath(path);
            t.create(this.db.doc(path), normalizeDoc(data, path) as DocumentData);
          },
          set: (path: string, data: DocInput) => {
            assertDocPath(path);
            t.set(this.db.doc(path), normalizeDoc(data, path) as DocumentData);
          },
          update: (path: string, patch: DocInput) => {
            assertDocPath(path);
            // 先頭階層の項目だけを置換する（項目名に '.' は使えないよう normalizeDoc で検証済み）。無ければ commit で NOT_FOUND
            const data = normalizeDoc(patch, path) as Record<string, unknown>;
            if (Object.keys(data).length === 0) throw new DocStoreError('INVALID', `empty update: ${path}`);
            t.update(this.db.doc(path), data);
          },
          delete: (path: string) => {
            assertDocPath(path);
            t.delete(this.db.doc(path));
          },
        };
        return work(tx);
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}
