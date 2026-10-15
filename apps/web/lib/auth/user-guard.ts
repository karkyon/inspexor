/**
 * CHG-008: セッションの利用者が今も有効かを確認する（無効化・ロール変更・パスワード再設定の後は、それ以前のセッションを使えない）。
 * セッション token は署名のみで状態を持たないため、利用者の文書（status / authChangedAt）を読んで照合する。
 * Firestore の読込を減らすため process 内で 30 秒キャッシュし、同じ process で利用者を変更したときは即時に破棄する。
 * CHG-012: 管理者の多要素認証が有効なとき、確認コードを済ませていない管理者の session は使えない（機能を有効にする前の session も再ログインが必要）。
 */
import { C, type DocReader, type UserDoc } from '@inspexor/docstore';
import { mfaRequiredFor } from '@inspexor/domain';
import type { SessionPayload } from './session-token';

export type UserGuard = (session: SessionPayload) => Promise<boolean>;

const TTL_MS = 30_000;
const cache = new Map<string, { readonly doc: Pick<UserDoc, 'status' | 'authChangedAt'> | null; readonly at: number }>();

export function invalidateUserGuard(userId: string): void {
  cache.delete(userId);
}

export interface UserGuardOptions {
  /** 管理者の多要素認証が有効か（既定は無効） */
  readonly adminMfaEnabled?: () => boolean;
}

export function createUserGuard(db: () => DocReader, now: () => number = () => Date.now(), options: UserGuardOptions = {}): UserGuard {
  return async (session) => {
    if (mfaRequiredFor(session.roles, options.adminMfaEnabled?.() ?? false) && session.mfa !== true) return false;
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
