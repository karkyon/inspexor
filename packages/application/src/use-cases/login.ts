/**
 * INSPEXOR_API・イベント設計書_v5.1.md API-001 `POST /auth/login` の業務ロジック。
 * SEC-002(Argon2id)、SEC-003(lockout)準拠。
 *
 * module境界（開発スタック定義書 §2/§5）に従い、application層はPrisma/Argon2 SDKを
 * 直接importしない。PasswordHasher/UserRepositoryはport（interface）であり、
 * 実装（apps/web側のadapter）が注入される。
 *
 * GAP: 用語・状態・コード定義書の error code にはログイン失敗固有のコードがない
 * （AUTH_REQUIREDのみ）。したがって「認証情報不正」もAUTH_REQUIREDで表現する。
 */

import { checkLockout, recordFailedAttempt, recordSuccessfulAttempt, type LockoutState } from '@inspexor/domain';

export type UserStatus = 'ACTIVE' | 'LOCKED' | 'INACTIVE';

export interface UserRecord {
  readonly id: string;
  readonly loginId: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly roles: readonly string[];
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export interface UserRepository {
  findByLoginId(loginId: string): Promise<UserRecord | null>;
  updateLockoutState(userId: string, state: LockoutState): Promise<void>;
}

export interface PasswordHasher {
  verify(plainPassword: string, hash: string): Promise<boolean>;
}

export interface LoginInput {
  readonly loginId: string;
  readonly password: string;
}

export interface LoginDeps {
  readonly userRepository: UserRepository;
  readonly passwordHasher: PasswordHasher;
  readonly now: Date;
}

export type LoginResult =
  | { readonly ok: true; readonly userId: string; readonly displayName: string; readonly roles: readonly string[] }
  | { readonly ok: false; readonly errorCode: 'AUTH_REQUIRED' | 'ACCOUNT_LOCKED' };

export async function login(input: LoginInput, deps: LoginDeps): Promise<LoginResult> {
  const user = await deps.userRepository.findByLoginId(input.loginId);

  if (!user || user.status !== 'ACTIVE') {
    // 存在しないloginIdと無効accountを区別しない（ユーザー列挙対策、SEC-010準拠）
    return { ok: false, errorCode: 'AUTH_REQUIRED' };
  }

  const lockoutState: LockoutState = { failedAttempts: user.failedAttempts, lockedUntil: user.lockedUntil };
  const lockout = checkLockout(lockoutState, deps.now);
  if (lockout.locked) {
    return { ok: false, errorCode: 'ACCOUNT_LOCKED' };
  }

  const passwordOk = await deps.passwordHasher.verify(input.password, user.passwordHash);
  if (!passwordOk) {
    const nextState = recordFailedAttempt(lockoutState, deps.now);
    await deps.userRepository.updateLockoutState(user.id, nextState);
    return { ok: false, errorCode: 'AUTH_REQUIRED' };
  }

  await deps.userRepository.updateLockoutState(user.id, recordSuccessfulAttempt());
  return { ok: true, userId: user.id, displayName: user.displayName, roles: user.roles };
}
