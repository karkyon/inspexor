/**
 * CHG-012 管理者の多要素認証（SEC-004 / G1-03）と再認証（SEC-026）。
 *
 *  ログイン: パスワードが正しく、管理者ロールを持ち、ADMIN_MFA_ENABLED が有効 → session を出さず「確認待ち」（5分）を返す
 *    未登録: setup で秘密鍵（QR コード）を作り、認証アプリの確認コードを verify すると登録完了。回復コード10個を一度だけ表示
 *    登録済み: 確認コード（または回復コード1つ）を verify すると session を出す
 *  確認コードの誤りはパスワードの誤りと同じく数え、5回で15分ロック（SEC-003）。同じコードの再利用は不可（lastStep）
 *  再認証: パスワード（多要素認証の登録者は確認コードも）を確かめ、session の認証時刻を更新する
 *  監査: 登録・回復コードの使用（残り数）・回復コードの再発行・解除（UserService）。秘密鍵・コードは残さない
 */
import { checkLockout, MFA_CHALLENGE_MINUTES, mfaRequiredFor, normalizeRecoveryCode, normalizeTotpCode, recordFailedAttempt, featureFlags } from '@inspexor/domain';
import { appendAudit, C, type DocStore, type DocTransaction, type UserDoc, type UserMfaDoc } from '@inspexor/docstore';
import type { PasswordHasher } from '@inspexor/application';
import QRCode from 'qrcode';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp, base32Decode } from './totp';
import { decryptMfaSecret, encryptMfaSecret, generateRecoveryCodes, hashRecoveryCode, issueMfaChallenge, verifyMfaChallenge, type MfaChallenge } from './mfa-crypto';
import { invalidateUserGuard } from './user-guard';

export class MfaError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly fields: ReadonlyArray<{ path: string; code: string; message: string }> = [],
  ) {
    super(message);
  }
}

export interface MfaChallengeView {
  readonly mfaRequired: true;
  readonly mfaEnrolled: boolean;
  readonly challenge: string;
  readonly challengeExpiresAt: string;
}

export interface MfaSetupView {
  readonly challenge: string;
  readonly challengeExpiresAt: string;
  /** 認証アプリに手入力するときの秘密鍵（4文字ごとに区切る） */
  readonly secret: string;
  readonly otpauthUri: string;
  /** QR コード（SVG） */
  readonly qrSvg: string;
}

export interface VerifiedUser {
  readonly id: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface MfaCode {
  readonly code?: string | undefined;
  readonly recoveryCode?: string | undefined;
}

const path = (id: string): string => `${C.users}/${id}`;
const expired = (): MfaError => new MfaError(401, 'AUTH_REQUIRED', '確認の期限が切れました。もう一度ログインしてください。', { challengeExpired: true });
const authChangedMs = (u: UserDoc): number => (u.authChangedAt ?? null)?.getTime() ?? 0;

export class MfaService {
  constructor(
    private readonly store: DocStore,
    private readonly secret: string,
    private readonly env: () => Readonly<Record<string, string | undefined>> = () => process.env,
  ) {}

  enabled(): boolean {
    return featureFlags(this.env()).adminMfa;
  }

  requiredFor(roles: readonly string[]): boolean {
    return mfaRequiredFor(roles, this.enabled());
  }

  /** パスワード確認の後: 多要素認証が必要なら確認待ちを返す（不要なら null） */
  async challengeFor(userId: string, now: Date): Promise<MfaChallengeView | null> {
    const u = await this.store.get<UserDoc>(path(userId));
    if (u === null || !this.requiredFor(u.roles)) return null;
    return this.challengeView({ v: 1, uid: userId, exp: now.getTime() + MFA_CHALLENGE_MINUTES * 60_000, acs: authChangedMs(u) }, (u.mfa ?? null) !== null);
  }

  private challengeView(c: MfaChallenge, enrolled: boolean): MfaChallengeView {
    return { mfaRequired: true, mfaEnrolled: enrolled, challenge: issueMfaChallenge(c, this.secret), challengeExpiresAt: new Date(c.exp).toISOString() };
  }

  private async readChallenge(token: string, now: Date): Promise<{ c: MfaChallenge; u: UserDoc }> {
    const c = verifyMfaChallenge(token, this.secret, now.getTime());
    if (c === null) throw expired();
    const u = await this.store.get<UserDoc>(path(c.uid));
    if (u === null || u.status !== 'ACTIVE' || authChangedMs(u) !== c.acs || !this.requiredFor(u.roles)) throw expired();
    if (checkLockout({ failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil }, now).locked) throw new MfaError(423, 'ACCOUNT_LOCKED', '認証に失敗しました。');
    return { c, u };
  }

  /** 未登録の管理者: 秘密鍵を作り、QR コードと、秘密鍵を含む確認待ちを返す（まだ保存しない） */
  async setup(token: string, now: Date): Promise<MfaSetupView> {
    const { c, u } = await this.readChallenge(token, now);
    if ((u.mfa ?? null) !== null) throw new MfaError(409, 'STATE_CONFLICT', '多要素認証は登録済みです。確認コードを入力してください。');
    const secret = generateTotpSecret();
    const b32 = base32Encode(secret);
    const uri = otpauthUri(b32, u.loginId);
    const next: MfaChallenge = { ...c, exp: now.getTime() + MFA_CHALLENGE_MINUTES * 60_000, pending: encryptMfaSecret(secret, this.secret) };
    const qrSvg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    return {
      challenge: issueMfaChallenge(next, this.secret),
      challengeExpiresAt: new Date(next.exp).toISOString(),
      secret: b32.replace(/(.{4})/g, '$1 ').trim(),
      otpauthUri: uri,
      qrSvg,
    };
  }

  /** 確認コード（登録時は必ず確認コード、登録済みなら回復コードも可）を確かめる。成功で登録・ロック回数のリセット */
  async verify(token: string, input: MfaCode, now: Date, correlationId: string): Promise<{ user: VerifiedUser; recoveryCodes: string[] | null }> {
    const { c } = await this.readChallenge(token, now);
    const enrolling = c.pending !== undefined;
    const fresh = enrolling ? generateRecoveryCodes() : null;
    const user = await this.store.runTransaction(async (tx) => {
      const u = await tx.get<UserDoc>(path(c.uid));
      if (u === null || u.status !== 'ACTIVE' || authChangedMs(u) !== c.acs) throw expired();
      if (enrolling && (u.mfa ?? null) !== null) throw new MfaError(409, 'STATE_CONFLICT', '多要素認証は既に登録されています。もう一度ログインしてください。', { challengeExpired: true });
      if (!enrolling && (u.mfa ?? null) === null) throw expired();
      const mfa: UserMfaDoc = enrolling
        ? { secretEnc: c.pending as string, enabledAt: now, lastStep: 0, recoveryHashes: [] }
        : (u.mfa as UserMfaDoc);
      const matched = this.match(c.uid, mfa, input, now, !enrolling);
      if (matched === null) {
        this.fail(tx, c.uid, u, now);
        return null;
      }
      const recoveryHashes =
        fresh !== null ? fresh.map((r) => hashRecoveryCode(c.uid, r, this.secret)) : matched.kind === 'recovery' ? mfa.recoveryHashes.filter((h) => h !== matched.hash) : mfa.recoveryHashes;
      const next: UserMfaDoc = { secretEnc: mfa.secretEnc, enabledAt: mfa.enabledAt, lastStep: matched.kind === 'totp' ? matched.step : mfa.lastStep, recoveryHashes };
      tx.update(path(c.uid), { mfa: next, failedAttempts: 0, lockedUntil: null, updatedAt: now });
      if (enrolling) {
        appendAudit(tx, { actorId: c.uid, action: 'MFA_ENROLL', targetType: 'USER', targetId: c.uid, afterData: { recoveryCodeCount: recoveryHashes.length }, correlationId, occurredAt: now }, now);
      } else if (matched.kind === 'recovery') {
        appendAudit(tx, { actorId: c.uid, action: 'MFA_RECOVERY_USED', targetType: 'USER', targetId: c.uid, afterData: { remaining: recoveryHashes.length }, correlationId, occurredAt: now }, now);
      }
      return { id: c.uid, displayName: u.displayName, roles: [...u.roles] };
    });
    if (user === null) throw new MfaError(401, 'AUTH_REQUIRED', '確認コードが正しくありません。', {}, [{ path: input.recoveryCode !== undefined ? '/recoveryCode' : '/code', code: 'invalid', message: '確認コードが正しくありません。' }]);
    invalidateUserGuard(c.uid);
    return { user, recoveryCodes: fresh };
  }

  /** 確認コード・回復コードの照合（一致しなければ null） */
  private match(userId: string, mfa: UserMfaDoc, input: MfaCode, now: Date, allowRecovery: boolean): { kind: 'totp'; step: number } | { kind: 'recovery'; hash: string } | null {
    if (input.code !== undefined) {
      const code = normalizeTotpCode(input.code);
      if (code === null) return null;
      const step = verifyTotp(decryptMfaSecret(mfa.secretEnc, this.secret), code, now.getTime(), mfa.lastStep);
      return step === null ? null : { kind: 'totp', step };
    }
    if (allowRecovery && input.recoveryCode !== undefined) {
      const rc = normalizeRecoveryCode(input.recoveryCode);
      if (rc === null) return null;
      const hash = hashRecoveryCode(userId, rc, this.secret);
      return mfa.recoveryHashes.includes(hash) ? { kind: 'recovery', hash } : null;
    }
    return null;
  }

  private fail(tx: DocTransaction, userId: string, u: UserDoc, now: Date): void {
    const next = recordFailedAttempt({ failedAttempts: u.failedAttempts, lockedUntil: u.lockedUntil }, now);
    tx.update(path(userId), { failedAttempts: next.failedAttempts, lockedUntil: next.lockedUntil, updatedAt: now });
  }

  /**
   * 再認証（SEC-026）: パスワードと、多要素認証が必要な利用者は確認コード（または回復コード）を確かめる。
   * 誤りはロックの回数に数える。成功で回数をリセット
   */
  async reauthenticate(userId: string, password: string, input: MfaCode, hasher: PasswordHasher, now: Date, correlationId: string): Promise<{ mfa: boolean }> {
    const u0 = await this.store.get<UserDoc>(path(userId));
    if (u0 === null || u0.status !== 'ACTIVE') throw new MfaError(401, 'AUTH_REQUIRED', '認証が必要です。');
    if (checkLockout({ failedAttempts: u0.failedAttempts, lockedUntil: u0.lockedUntil }, now).locked) throw new MfaError(423, 'ACCOUNT_LOCKED', '認証に失敗しました。しばらく時間をおいてから再度お試しください。');
    const passwordOk = await hasher.verify(password, u0.passwordHash);
    const needMfa = this.requiredFor(u0.roles) && (u0.mfa ?? null) !== null;
    const result = await this.store.runTransaction(async (tx) => {
      const u = await tx.get<UserDoc>(path(userId));
      if (u === null || u.status !== 'ACTIVE') return 'auth' as const;
      if (!passwordOk) {
        this.fail(tx, userId, u, now);
        return 'password' as const;
      }
      let patch: Partial<UserDoc> = {};
      if (needMfa) {
        const mfa = u.mfa as UserMfaDoc;
        const matched = this.match(userId, mfa, input, now, true);
        if (matched === null) {
          this.fail(tx, userId, u, now);
          return 'code' as const;
        }
        const recoveryHashes = matched.kind === 'recovery' ? mfa.recoveryHashes.filter((h) => h !== matched.hash) : mfa.recoveryHashes;
        patch = { mfa: { ...mfa, lastStep: matched.kind === 'totp' ? matched.step : mfa.lastStep, recoveryHashes } };
        if (matched.kind === 'recovery') {
          appendAudit(tx, { actorId: userId, action: 'MFA_RECOVERY_USED', targetType: 'USER', targetId: userId, afterData: { remaining: recoveryHashes.length, purpose: 'reauth' }, correlationId, occurredAt: now }, now);
        }
      }
      tx.update(path(userId), { ...patch, failedAttempts: 0, lockedUntil: null, updatedAt: now });
      appendAudit(tx, { actorId: userId, action: 'REAUTHENTICATE', targetType: 'USER', targetId: userId, afterData: { mfa: needMfa }, correlationId, occurredAt: now }, now);
      return 'ok' as const;
    });
    if (result === 'auth') throw new MfaError(401, 'AUTH_REQUIRED', '認証が必要です。');
    if (result === 'password') throw new MfaError(422, 'VALIDATION_ERROR', 'パスワードが正しくありません。', {}, [{ path: '/password', code: 'invalid', message: 'パスワードが正しくありません。' }]);
    if (result === 'code') {
      const p = input.recoveryCode !== undefined ? '/recoveryCode' : '/code';
      throw new MfaError(422, 'VALIDATION_ERROR', '確認コードが正しくありません。', {}, [{ path: p, code: input.code === undefined && input.recoveryCode === undefined ? 'required' : 'invalid', message: '確認コードを入力してください。' }]);
    }
    return { mfa: needMfa };
  }

  /** 回復コードの再発行（本人。登録済みの管理者のみ）。古い回復コードは使えなくなる */
  async regenerateRecoveryCodes(userId: string, now: Date, correlationId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await this.store.runTransaction(async (tx) => {
      const u = await tx.get<UserDoc>(path(userId));
      if (u === null || (u.mfa ?? null) === null) throw new MfaError(409, 'STATE_CONFLICT', '多要素認証が登録されていません。');
      const mfa = u.mfa as UserMfaDoc;
      tx.update(path(userId), { mfa: { ...mfa, recoveryHashes: codes.map((r) => hashRecoveryCode(userId, r, this.secret)) }, updatedAt: now });
      appendAudit(tx, { actorId: userId, action: 'MFA_RECOVERY_REGENERATE', targetType: 'USER', targetId: userId, beforeData: { remaining: mfa.recoveryHashes.length }, afterData: { recoveryCodeCount: codes.length }, correlationId, occurredAt: now }, now);
    });
    return codes;
  }

  /** 本人の状態（アカウント画面） */
  async status(userId: string): Promise<{ required: boolean; enrolled: boolean; enabledAt: string | null; recoveryCodesRemaining: number }> {
    const u = await this.store.get<UserDoc>(path(userId));
    const mfa = u?.mfa ?? null;
    return { required: u !== null && this.requiredFor(u.roles), enrolled: mfa !== null, enabledAt: mfa?.enabledAt.toISOString() ?? null, recoveryCodesRemaining: mfa?.recoveryHashes.length ?? 0 };
  }
}

/** 試験用: 秘密鍵（暗号文）から現在の確認コードを作る */
export function secretFromEnc(enc: string, authSecret: string): string {
  return base32Encode(decryptMfaSecret(enc, authSecret));
}
export { base32Decode };
