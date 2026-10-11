/**
 * 試験用の DocStore（サンドボックスで Firestore エミュレータを使えないための代替）。
 * Firestore と同じ制約を再現する: transaction 内の「読込→書込」順、create/update の存在確認、
 * 書込 500 件上限、配列の入れ子禁止、検索の制約と複合索引（firestore.indexes.json）の有無。
 * transaction は直列に実行する（並行時の再試行は Firestore エミュレータの結合試験で確認する）。
 */
import { assertCollectionPath, assertDocPath, DocStoreError, type Doc, type DocInput, type DocStore, type DocTransaction, type QuerySpec, type Snapshot } from './types';
import { cloneDoc, normalizeDoc } from './values';
import { findIndex, needsCompositeIndex, planQuery, runQuery, type IndexDefinition } from './query';

type Write =
  | { kind: 'create' | 'set'; path: string; data: Doc }
  | { kind: 'update'; path: string; data: Doc }
  | { kind: 'delete'; path: string };

const MAX_WRITES = 500;

export interface MemoryDocStoreOptions {
  /** firestore.indexes.json の indexes。指定時は複合索引が無い検索を INDEX_REQUIRED で失敗させる */
  readonly indexes?: readonly IndexDefinition[];
}

export class MemoryDocStore implements DocStore {
  private readonly docs = new Map<string, Doc>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly indexes: readonly IndexDefinition[] | undefined;
  /** 試験用: 実行した検索の数 */
  queryCount = 0;

  constructor(options: MemoryDocStoreOptions = {}) {
    this.indexes = options.indexes;
  }

  async get<T = Doc>(path: string): Promise<T | null> {
    assertDocPath(path);
    const d = this.docs.get(path);
    return d === undefined ? null : cloneDoc<T>(d);
  }

  async getMany<T = Doc>(paths: readonly string[]): Promise<Array<T | null>> {
    return Promise.all(paths.map((p) => this.get<T>(p)));
  }

  async query<T = Doc>(collection: string, spec: QuerySpec = {}): Promise<Array<Snapshot<T>>> {
    const parts = assertCollectionPath(collection);
    const { orders, filters } = planQuery(collection, spec);
    if (this.indexes !== undefined && needsCompositeIndex({ ...spec, orderBy: orders })) {
      const group = parts[parts.length - 1] as string;
      if (findIndex(group, spec, orders, this.indexes) === null) {
        throw new DocStoreError(
          'INDEX_REQUIRED',
          `${collection}: composite index required (where=${JSON.stringify(spec.where ?? [])} orderBy=${JSON.stringify(orders)})`,
        );
      }
    }
    this.queryCount += 1;
    const prefix = `${collection}/`;
    const candidates: Array<{ id: string; data: Doc }> = [];
    for (const [path, data] of this.docs) {
      if (!path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      if (id.includes('/')) continue;
      candidates.push({ id, data });
    }
    return runQuery<Doc>(candidates, filters, orders, spec.limit).map((d) => ({ id: d.id, path: `${prefix}${d.id}`, data: cloneDoc<T>(d.data) }));
  }

  async count(collection: string, spec: QuerySpec = {}): Promise<number> {
    const { limit: _ignored, ...rest } = spec;
    return (await this.query(collection, rest)).length;
  }

  async runTransaction<T>(work: (tx: DocTransaction) => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.execute(work));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async execute<T>(work: (tx: DocTransaction) => Promise<T>): Promise<T> {
    const writes: Write[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const store = this;
    const guardRead = (): void => {
      if (writes.length > 0) throw new DocStoreError('INVALID', 'Firestore transactions require all reads to be executed before all writes');
    };
    const push = (w: Write): void => {
      if (writes.length >= MAX_WRITES) throw new DocStoreError('INVALID', `transaction exceeds ${MAX_WRITES} writes`);
      writes.push(w);
    };
    const tx: DocTransaction = {
      async get<R = Doc>(path: string) {
        guardRead();
        return store.get<R>(path);
      },
      async getMany<R = Doc>(paths: readonly string[]) {
        guardRead();
        return store.getMany<R>(paths);
      },
      async query<R = Doc>(collection: string, spec?: QuerySpec) {
        guardRead();
        return store.query<R>(collection, spec);
      },
      create(path: string, data: DocInput) {
        assertDocPath(path);
        push({ kind: 'create', path, data: normalizeDoc(data, path) });
      },
      set(path: string, data: DocInput) {
        assertDocPath(path);
        push({ kind: 'set', path, data: normalizeDoc(data, path) });
      },
      update(path: string, patch: DocInput) {
        assertDocPath(path);
        const data = normalizeDoc(patch, path);
        if (Object.keys(data).length === 0) throw new DocStoreError('INVALID', `empty update: ${path}`);
        push({ kind: 'update', path, data });
      },
      delete(path: string) {
        assertDocPath(path);
        push({ kind: 'delete', path });
      },
    };
    const result = await work(tx);
    // commit: 失敗なら何も反映しない
    const staged = new Map<string, Doc | null>();
    const current = (p: string): Doc | null => (staged.has(p) ? (staged.get(p) as Doc | null) : this.docs.get(p) ?? null);
    for (const w of writes) {
      if (w.kind === 'create') {
        if (current(w.path) !== null) throw new DocStoreError('ALREADY_EXISTS', `document already exists: ${w.path}`);
        staged.set(w.path, w.data);
      } else if (w.kind === 'set') {
        staged.set(w.path, w.data);
      } else if (w.kind === 'update') {
        const base = current(w.path);
        if (base === null) throw new DocStoreError('NOT_FOUND', `no document to update: ${w.path}`);
        staged.set(w.path, { ...base, ...w.data });
      } else {
        staged.set(w.path, null);
      }
    }
    for (const [p, d] of staged) {
      if (d === null) this.docs.delete(p);
      else this.docs.set(p, d);
    }
    return result;
  }

  async close(): Promise<void> {
    await this.chain;
  }

  /** 試験用: 全文書のパス */
  paths(): string[] {
    return [...this.docs.keys()].sort();
  }
}
