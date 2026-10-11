/**
 * CHG-008: セッションの利用者が今も有効かを確認する（無効化・ロール変更・パスワード再設定の後は、それ以前のセッションを使えない）。
 * セッション token は署名のみで状態を持たないため、利用者の文書（status / authChangedAt）を読んで照合する。
 * Firestore の読込を減らすため process 内で 30 秒キャッシュし、同じ process で利用者を変更したときは即時に破棄する。
 */
import { C, type DocReader, type UserDoc } from '@inspexor/docstore';
import type { SessionPayload } from './session-token';

export type UserGuard = (session: SessionPayload) => Promise<boolean>;

const TTL_MS = 30_000;
const cache = new Map<string, { readonly doc: Pick<UserDoc, 'status' | 'authChangedAt'> | null; readonly at: number }>();

export function invalidateUserGuard(userId: string): void {
  cache.delete(userId);
}

export function createUserGuard(db: () => DocReader, now: () => number = () => Date.now()): UserGuard {
  return async (session) => {
    let entry = cache.get(session.userId);
    if (entry === undefined || now() - entry.at > TTL_MS) {
      const doc = await db().get<UserDoc>(`${C.users}/${session.userId}`);
      entry = { doc: doc === null ? null : { status: doc.status, authChangedAt: doc.authChangedAt ?? null }, at: now() };
      cache.set(session.userId, entry);
    }
    const doc = entry.doc;
    if (doc === null || doc.status !== 'ACTIVE') return false;
    const changed = doc.authChangedAt ?? null;
    return changed === null || changed.getTime() <= new Date(session.issuedAt).getTime();
  };
}
