/**
 * 端末下書き（FR-016 / REQ-OFF-001 / 機能別詳細設計書 draft/confirm）。
 *  - sessionStorage のみ。key = `inspexor:{userId}:{type}:draft:v1`
 *  - 秘密値を含めない（AES 不要）。updatedAt が 24 時間を超えたら破棄
 *  - logout / confirm 成功で削除
 */
export type DraftType = 'work' | 'delivery';

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'inspexor:';

export interface StoredDraft<T> {
  readonly v: 1;
  readonly updatedAt: string;
  readonly step: number;
  readonly data: T;
  /** server に保存済みなら header id と version（PATCH / confirm 用） */
  readonly serverId: string | null;
  readonly serverVersion: number | null;
  readonly reportNo: string | null;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export function draftKey(userId: string, type: DraftType): string {
  return `${PREFIX}${userId}:${type}:draft:v1`;
}

function storageOrNull(storage?: KeyValueStorage): KeyValueStorage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadDraft<T>(userId: string, type: DraftType, now: Date = new Date(), storage?: KeyValueStorage): StoredDraft<T> | null {
  const s = storageOrNull(storage);
  if (s === null) return null;
  try {
    const raw = s.getItem(draftKey(userId, type));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredDraft<T>;
    const updated = new Date(parsed.updatedAt).getTime();
    if (parsed.v !== 1 || Number.isNaN(updated) || now.getTime() - updated > DRAFT_TTL_MS) {
      s.removeItem(draftKey(userId, type));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * logout 後の書き戻し防止（REQ-OFF-001）: 入力の自動保存（1秒遅延）が logout と画面遷移の間に発火すると、
 * 削除した下書きが復活する。clearAllDrafts から次のログイン確認（resumeDrafts）までは保存しない。
 */
let suspended = false;

/** ログイン済みを確認した時（現場画面の /me 成功時）に呼ぶ */
export function resumeDrafts(): void {
  suspended = false;
}

/** 保存できたら true（storage 不可・容量超過は false＝画面で警告。logout 直後は書かずに true） */
export function saveDraft<T>(userId: string, type: DraftType, draft: Omit<StoredDraft<T>, 'v' | 'updatedAt'>, now: Date = new Date(), storage?: KeyValueStorage): boolean {
  if (suspended) return true;
  const s = storageOrNull(storage);
  if (s === null) return false;
  try {
    const value: StoredDraft<T> = { v: 1, updatedAt: now.toISOString(), ...draft };
    s.setItem(draftKey(userId, type), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(userId: string, type: DraftType, storage?: KeyValueStorage): void {
  const s = storageOrNull(storage);
  try {
    s?.removeItem(draftKey(userId, type));
  } catch {
    // storage 不可でも処理は継続
  }
}

/** logout 時: この端末の INSPEXOR 下書きをすべて削除 */
export function clearAllDrafts(storage?: KeyValueStorage): void {
  suspended = true;
  const s = storageOrNull(storage);
  if (s === null) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k !== null && k.startsWith(PREFIX) && k.endsWith(':draft:v1')) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // noop
  }
}
