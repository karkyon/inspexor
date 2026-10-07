cd ~/inspexor

# ============================================================
# 0. g0_batch.sh クリーンアップ（誤commit分の削除）
# ============================================================
git rm -f g0_batch.sh 2>/dev/null || rm -f g0_batch.sh

# ============================================================
# 1. packages/domain/src/auth-lockout.ts
# ============================================================
cat > packages/domain/src/auth-lockout.ts << 'EOF'
/**
 * INSPEXOR_セキュリティ・プライバシー・データ保護詳細仕様_v5.1.md SEC-003準拠。
 * 5回失敗で15分ロック、成功時はfailed_attemptsをresetする。
 * schema.sql app.users: failed_attempts int, locked_until timestamptz。
 */

export interface LockoutState {
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MINUTES = 15;

export type LockoutCheckResult =
  | { readonly locked: false }
  | { readonly locked: true; readonly lockedUntil: Date };

export function checkLockout(state: LockoutState, now: Date): LockoutCheckResult {
  if (state.lockedUntil && state.lockedUntil.getTime() > now.getTime()) {
    return { locked: true, lockedUntil: state.lockedUntil };
  }
  return { locked: false };
}

export function recordFailedAttempt(state: LockoutState, now: Date): LockoutState {
  const nextAttempts = state.failedAttempts + 1;
  if (nextAttempts >= LOCKOUT_THRESHOLD) {
    return {
      failedAttempts: nextAttempts,
      lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MINUTES * 60_000),
    };
  }
  return { failedAttempts: nextAttempts, lockedUntil: state.lockedUntil };
}

export function recordSuccessfulAttempt(): LockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
EOF

cat > packages/domain/src/auth-lockout.test.ts << 'EOF'
import { describe, it, expect } from 'vitest';
import { checkLockout, recordFailedAttempt, recordSuccessfulAttempt, LOCKOUT_THRESHOLD } from './auth-lockout';

const NOW = new Date('2026-10-07T00:00:00Z');

describe('auth-lockout: SEC-003準拠（5回失敗/15分ロック）', () => {
  it('ロックなし状態はlocked:false', () => {
    expect(checkLockout({ failedAttempts: 0, lockedUntil: null }, NOW)).toEqual({ locked: false });
  });

  it('4回失敗まではロックしない', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i += 1) {
      state = recordFailedAttempt(state, NOW);
    }
    expect(state.failedAttempts).toBe(4);
    expect(state.lockedUntil).toBeNull();
    expect(checkLockout(state, NOW)).toEqual({ locked: false });
  });

  it('5回目の失敗で15分ロックされる', () => {
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      state = recordFailedAttempt(state, NOW);
    }
    expect(state.failedAttempts).toBe(5);
    expect(state.lockedUntil).toEqual(new Date('2026-10-07T00:15:00Z'));
    const check = checkLockout(state, NOW);
    expect(check.locked).toBe(true);
  });

  it('ロック期限経過後はlocked:false', () => {
    const lockedState = { failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:15:00Z') };
    const after = new Date('2026-10-07T00:15:01Z');
    expect(checkLockout(lockedState, after)).toEqual({ locked: false });
  });

  it('成功時はfailedAttempts/lockedUntilがresetされる', () => {
    expect(recordSuccessfulAttempt()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});
EOF

# index.ts に auth-lockout を追加
cat > packages/domain/src/index.ts << 'EOF'
export * from './money';
export * from './business-time';
export * from './rate-calculation';
export * from './transport-allocation';
export * from './tax';
export * from './record-status';
export * from './billing-status';
export * from './error-codes';
export * from './idempotency';
export * from './auth-lockout';
EOF

# ============================================================
# 2. packages/application: 依存追加（domain workspace参照 + test基盤）
# ============================================================
cd packages/application
pnpm add "@inspexor/domain@workspace:*"
pnpm add -D vitest@^2.1.3 typescript@^5.6.3 @types/node@^22.0.0
cd ~/inspexor

# ============================================================
# 3. packages/application/src/command-pipeline.ts
# ============================================================
mkdir -p packages/application/src/use-cases
cat > packages/application/src/command-pipeline.ts << 'EOF'
/**
 * docs/adr/0001-gap-003-command-pipeline-order.md 準拠。
 * 00契約 不変条件2の順序（00契約を機能別詳細設計書より優先）:
 * 認証 → CSRF → 認可(role/owner) → Zod → expectedVersion → state guard → 業務制約
 *
 * domain invariant検証、revision/audit/outbox挿入、version+1、commitはこのpipelineの外
 * （application service内でDB transactionとして実行する責務であり、ここには含めない）。
 */

import type { ErrorCode } from '@inspexor/domain';

export type PipelineStepName =
  | 'authentication'
  | 'csrf'
  | 'authorization'
  | 'validation'
  | 'version'
  | 'state'
  | 'businessRule';

export interface PipelineStepResult {
  readonly ok: boolean;
  readonly errorCode?: ErrorCode;
  readonly message?: string;
}

export type PipelineStep<TContext> = (ctx: TContext) => PipelineStepResult | Promise<PipelineStepResult>;

export interface PipelineDefinition<TContext> {
  readonly authentication: PipelineStep<TContext>;
  readonly csrf: PipelineStep<TContext>;
  readonly authorization: PipelineStep<TContext>;
  readonly validation: PipelineStep<TContext>;
  readonly version: PipelineStep<TContext>;
  readonly state: PipelineStep<TContext>;
  readonly businessRule: PipelineStep<TContext>;
}

// ADR-0001で確定した検査順序。この配列の並びがそのまま契約である。
const STEP_ORDER: readonly PipelineStepName[] = [
  'authentication',
  'csrf',
  'authorization',
  'validation',
  'version',
  'state',
  'businessRule',
];

export type PipelineOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failedStep: PipelineStepName;
      readonly errorCode?: ErrorCode;
      readonly message?: string;
    };

export async function runCommandPipeline<TContext>(
  definition: PipelineDefinition<TContext>,
  context: TContext,
): Promise<PipelineOutcome> {
  for (const stepName of STEP_ORDER) {
    const step = definition[stepName];
    // eslint-disable-next-line no-await-in-loop
    const result = await step(context);
    if (!result.ok) {
      return { ok: false, failedStep: stepName, errorCode: result.errorCode, message: result.message };
    }
  }
  return { ok: true };
}

export const COMMAND_PIPELINE_STEP_ORDER = STEP_ORDER;
EOF

cat > packages/application/src/command-pipeline.test.ts << 'EOF'
import { describe, it, expect, vi } from 'vitest';
import { runCommandPipeline, COMMAND_PIPELINE_STEP_ORDER, type PipelineDefinition } from './command-pipeline';

function okStep() {
  return vi.fn().mockReturnValue({ ok: true });
}

describe('command-pipeline: ADR-0001順序準拠', () => {
  it('ステップ順序はADR-0001どおり', () => {
    expect(COMMAND_PIPELINE_STEP_ORDER).toEqual([
      'authentication', 'csrf', 'authorization', 'validation', 'version', 'state', 'businessRule',
    ]);
  });

  it('全ステップPASSなら ok:true、全ステップが呼ばれる', async () => {
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: okStep(),
      csrf: okStep(),
      authorization: okStep(),
      validation: okStep(),
      version: okStep(),
      state: okStep(),
      businessRule: okStep(),
    };
    const result = await runCommandPipeline(steps, {});
    expect(result).toEqual({ ok: true });
    for (const name of COMMAND_PIPELINE_STEP_ORDER) {
      expect(steps[name]).toHaveBeenCalledTimes(1);
    }
  });

  it('認可(authorization)失敗時はvalidation以降が呼ばれない（short-circuit）', async () => {
    const authorization = vi.fn().mockReturnValue({ ok: false, errorCode: 'FORBIDDEN', message: '権限なし' });
    const validation = okStep();
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: okStep(),
      csrf: okStep(),
      authorization,
      validation,
      version: okStep(),
      state: okStep(),
      businessRule: okStep(),
    };
    const result = await runCommandPipeline(steps, {});
    expect(result).toEqual({ ok: false, failedStep: 'authorization', errorCode: 'FORBIDDEN', message: '権限なし' });
    expect(validation).not.toHaveBeenCalled();
  });

  it('認証(authentication)はCSRFより先に検査される', async () => {
    const callOrder: string[] = [];
    const makeStep = (name: string) => vi.fn().mockImplementation(() => {
      callOrder.push(name);
      return { ok: true };
    });
    const steps: PipelineDefinition<Record<string, never>> = {
      authentication: makeStep('authentication'),
      csrf: makeStep('csrf'),
      authorization: makeStep('authorization'),
      validation: makeStep('validation'),
      version: makeStep('version'),
      state: makeStep('state'),
      businessRule: makeStep('businessRule'),
    };
    await runCommandPipeline(steps, {});
    expect(callOrder).toEqual([
      'authentication', 'csrf', 'authorization', 'validation', 'version', 'state', 'businessRule',
    ]);
  });
});
EOF

# ============================================================
# 4. packages/application/src/use-cases/login.ts
# ============================================================
cat > packages/application/src/use-cases/login.ts << 'EOF'
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
EOF

cat > packages/application/src/use-cases/login.test.ts << 'EOF'
import { describe, it, expect, vi } from 'vitest';
import { login, type UserRecord, type UserRepository, type PasswordHasher } from './login';

const NOW = new Date('2026-10-07T00:00:00Z');

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'user-1',
    loginId: 'taro',
    passwordHash: 'hashed',
    displayName: '太郎',
    status: 'ACTIVE',
    roles: ['FIELD'],
    failedAttempts: 0,
    lockedUntil: null,
    ...overrides,
  };
}

function makeRepo(user: UserRecord | null): UserRepository & { updateLockoutState: ReturnType<typeof vi.fn> } {
  return {
    findByLoginId: vi.fn().mockResolvedValue(user),
    updateLockoutState: vi.fn().mockResolvedValue(undefined),
  };
}

describe('login use-case: API-001/SEC-002/SEC-003準拠', () => {
  it('正しいID/passwordで成功', async () => {
    const user = makeUser();
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(true) };
    const result = await login({ loginId: 'taro', password: 'correct' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: true, userId: 'user-1', displayName: '太郎', roles: ['FIELD'] });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 0, lockedUntil: null });
  });

  it('存在しないloginIdはAUTH_REQUIRED（列挙対策）', async () => {
    const repo = makeRepo(null);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'ghost', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
  });

  it('INACTIVEユーザーはAUTH_REQUIRED', async () => {
    const user = makeUser({ status: 'INACTIVE' });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'taro', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
  });

  it('ロック中はACCOUNT_LOCKED（パスワード検証はしない）', async () => {
    const user = makeUser({ failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:10:00Z') });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn() };
    const result = await login({ loginId: 'taro', password: 'x' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'ACCOUNT_LOCKED' });
    expect(hasher.verify).not.toHaveBeenCalled();
  });

  it('誤passwordはfailedAttemptsを加算してAUTH_REQUIRED', async () => {
    const user = makeUser({ failedAttempts: 3 });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(false) };
    const result = await login({ loginId: 'taro', password: 'wrong' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(result).toEqual({ ok: false, errorCode: 'AUTH_REQUIRED' });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 4, lockedUntil: null });
  });

  it('5回目の誤passwordでlockedUntilが設定される', async () => {
    const user = makeUser({ failedAttempts: 4 });
    const repo = makeRepo(user);
    const hasher: PasswordHasher = { verify: vi.fn().mockResolvedValue(false) };
    await login({ loginId: 'taro', password: 'wrong' }, { userRepository: repo, passwordHasher: hasher, now: NOW });
    expect(repo.updateLockoutState).toHaveBeenCalledWith('user-1', { failedAttempts: 5, lockedUntil: new Date('2026-10-07T00:15:00Z') });
  });
});
EOF

# ============================================================
# 5. packages/application/src/index.ts
# ============================================================
cat > packages/application/src/index.ts << 'EOF'
export * from './command-pipeline';
export * from './use-cases/login';
EOF

# ============================================================
# 6. インストール＋検証
# ============================================================
pnpm install

echo "=== domain: tsc --noEmit ==="
(cd packages/domain && npx tsc --noEmit)

echo "=== domain: vitest run ==="
(cd packages/domain && npx vitest run)

echo "=== application: tsc --noEmit ==="
(cd packages/application && npx tsc --noEmit)

echo "=== application: vitest run ==="
(cd packages/application && npx vitest run)
