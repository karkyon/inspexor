/**
 * CHG-006: 文書型データベース（Firestore）への最小 port。
 * 業務サービスはこの interface だけに依存し、本番・開発は FirestoreDocStore、
 * サンドボックスの試験は MemoryDocStore（Firestore と同じ制約を再現）で動かす。
 *
 * 値: string / number / boolean / null / Date / 配列（配列の入れ子は不可: Firestore の制約）/ object。
 * undefined の項目は保存しない。日時は Date（Firestore では Timestamp）、業務日は 'YYYY-MM-DD' 文字列。
 */
export type Scalar = string | number | boolean | null | Date;
export type Value = Scalar | readonly Value[] | { readonly [key: string]: Value | undefined };
export type Doc = { readonly [key: string]: Value | undefined };
/** 書込の入力（interface 型もそのまま渡せるよう object。値の検証は実行時に行う） */
export type DocInput = object;

export type FilterOp = '==' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';

export interface Filter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: Value;
}

export interface Order {
  readonly field: string;
  readonly dir?: 'asc' | 'desc';
}

export interface QuerySpec {
  readonly where?: readonly Filter[];
  readonly orderBy?: readonly Order[];
  readonly limit?: number;
}

export interface Snapshot<T> {
  readonly id: string;
  readonly path: string;
  readonly data: T;
}

export interface DocReader {
  /** 文書パス（例 `workReports/{id}`、`workReports/{id}/revisions/1`）。無ければ null */
  get<T = Doc>(path: string): Promise<T | null>;
  getMany<T = Doc>(paths: readonly string[]): Promise<Array<T | null>>;
  /** コレクションパス（例 `workReports`、`workReports/{id}/revisions`） */
  query<T = Doc>(collection: string, spec?: QuerySpec): Promise<Array<Snapshot<T>>>;
}

/**
 * transaction（Firestore と同じ規則: すべての読込は最初の書込より前。違反は例外）。
 * 書込は commit 時にまとめて反映し、途中で例外なら何も反映しない。
 */
export interface DocTransaction extends DocReader {
  /** 既にあれば commit 時に ALREADY_EXISTS */
  create(path: string, data: DocInput): void;
  set(path: string, data: DocInput): void;
  /** 先頭階層の項目を置き換える（入れ子 object は丸ごと置換）。無ければ commit 時に NOT_FOUND */
  update(path: string, patch: DocInput): void;
  delete(path: string): void;
}

export interface DocStore extends DocReader {
  runTransaction<T>(work: (tx: DocTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DocStoreErrorCode = 'ALREADY_EXISTS' | 'NOT_FOUND' | 'INVALID' | 'INDEX_REQUIRED';

export class DocStoreError extends Error {
  constructor(
    readonly code: DocStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DocStoreError';
  }
}

export function isDocStoreError(error: unknown, code?: DocStoreErrorCode): error is DocStoreError {
  return error instanceof DocStoreError && (code === undefined || error.code === code);
}

/** Firestore の文書 ID 制約（'/' 不可、'.' '..' 不可、__x__ 不可、1500 byte 以内）に合わせて安全な ID にする */
export function safeId(raw: string): string {
  const encoded = encodeURIComponent(raw).replace(/\./g, '%2E');
  if (Buffer.byteLength(encoded, 'utf8') > 1500) throw new DocStoreError('INVALID', 'document id too long');
  return encoded.startsWith('__') ? `%5F${encoded.slice(1)}` : encoded;
}

/** 文書パスの検証（偶数個のセグメント、空セグメント不可） */
export function assertDocPath(path: string): string[] {
  const parts = path.split('/');
  if (parts.length < 2 || parts.length % 2 !== 0 || parts.some((p) => p.length === 0)) {
    throw new DocStoreError('INVALID', `invalid document path: ${path}`);
  }
  return parts;
}

export function assertCollectionPath(path: string): string[] {
  const parts = path.split('/');
  if (parts.length % 2 !== 1 || parts.some((p) => p.length === 0)) {
    throw new DocStoreError('INVALID', `invalid collection path: ${path}`);
  }
  return parts;
}
