#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

# ============================================================
# 1. apps/web/app/api/health/route.ts : TS2742修正
#    （GETの戻り値を明示 Promise<Response> にし、
#     composite:true 下での undici-types 非ポータブル推論エラーを解消）
# ============================================================
cat > apps/web/app/api/health/route.ts << 'EOF'
import { Pool } from "pg";

// 本エンドポイントはG0以前の「環境が実際に稼働しているか」の確認専用。
// 業務ロジックは含まない。DATABASE_URLへの実接続をSELECT 1で検証する。
export async function GET(): Promise<Response> {
  const startedAt = Date.now();
  const result: { app: string; db: "ok" | "ng"; error?: string; latencyMs?: number } = {
    app: "ok",
    db: "ng",
  };

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Response.json({ ...result, error: "DATABASE_URL is not set" }, { status: 500 });
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("SELECT 1");
    result.db = "ok";
    result.latencyMs = Date.now() - startedAt;
    return Response.json(result, { status: 200 });
  } catch (err) {
    return Response.json(
      { ...result, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await pool.end();
  }
}
EOF

# ============================================================
# 2. apps/web/lib/auth/prisma-user-repository.ts
#    UserRepositoryポート(@inspexor/application)のPrismaアダプタ。
#    schema.prisma の実フィールド名(loginId/passwordHash/displayName/
#    status/failedAttempts/lockedUntil/roles:UserRole[].role)に基づく。
# ============================================================
mkdir -p apps/web/lib/auth
cat > apps/web/lib/auth/prisma-user-repository.ts << 'EOF'
import type { PrismaClient } from '@prisma/client';
import type { LockoutState } from '@inspexor/domain';
import type { UserRepository, UserRecord } from '@inspexor/application';

// ports-and-adapters: apps/web のみがPrisma Client(provider SDK)を直接importできる層。
// UserRepositoryポートは packages/application/src/use-cases/login.ts で定義。
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByLoginId(loginId: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { loginId },
      include: { roles: true },
    });
    if (!user) {
      return null;
    }
    return {
      id: user.id,
      loginId: user.loginId,
      passwordHash: user.passwordHash,
      displayName: user.displayName,
      status: user.status,
      roles: user.roles.map((userRole) => userRole.role),
      failedAttempts: user.failedAttempts,
      lockedUntil: user.lockedUntil,
    };
  }

  async updateLockoutState(userId: string, state: LockoutState): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedAttempts: state.failedAttempts,
        lockedUntil: state.lockedUntil,
      },
    });
  }
}
EOF

cat > apps/web/lib/auth/prisma-user-repository.test.ts << 'EOF'
import { describe, it, expect, vi } from 'vitest';
import { PrismaUserRepository } from './prisma-user-repository';
import type { PrismaClient } from '@prisma/client';

// PrismaClientの型は実生成物（prisma generate後）に依拠するため、
// テストでは user.findUnique / user.update のみを満たす最小モックを使う。
type MockPrismaClient = Pick<PrismaClient, 'user'>;

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u-1',
    loginId: 'tanaka',
    passwordHash: '$argon2id$dummy',
    displayName: '田中太郎',
    status: 'ACTIVE' as const,
    failedAttempts: 0,
    lockedUntil: null,
    version: 1,
    roles: [{ userId: 'u-1', role: 'OFFICE' as const }],
    ...overrides,
  };
}

describe('PrismaUserRepository: findByLoginId', () => {
  it('存在するloginIdでUserRecordを返す（rolesはroleコードの配列に変換）', async () => {
    const findUnique = vi.fn().mockResolvedValue(makeUser());
    const prisma = { user: { findUnique, update: vi.fn() } } as unknown as MockPrismaClient;
    const repo = new PrismaUserRepository(prisma as PrismaClient);

    const result = await repo.findByLoginId('tanaka');

    expect(findUnique).toHaveBeenCalledWith({
      where: { loginId: 'tanaka' },
      include: { roles: true },
    });
    expect(result).toEqual({
      id: 'u-1',
      loginId: 'tanaka',
      passwordHash: '$argon2id$dummy',
      displayName: '田中太郎',
      status: 'ACTIVE',
      roles: ['OFFICE'],
      failedAttempts: 0,
      lockedUntil: null,
    });
  });

  it('存在しないloginIdはnullを返す', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { user: { findUnique, update: vi.fn() } } as unknown as MockPrismaClient;
    const repo = new PrismaUserRepository(prisma as PrismaClient);

    expect(await repo.findByLoginId('nobody')).toBeNull();
  });

  it('複数roleは複数コードの配列に変換される', async () => {
    const findUnique = vi.fn().mockResolvedValue(
      makeUser({
        roles: [
          { userId: 'u-1', role: 'OFFICE' },
          { userId: 'u-1', role: 'ADMIN' },
        ],
      }),
    );
    const prisma = { user: { findUnique, update: vi.fn() } } as unknown as MockPrismaClient;
    const repo = new PrismaUserRepository(prisma as PrismaClient);

    const result = await repo.findByLoginId('tanaka');
    expect(result?.roles).toEqual(['OFFICE', 'ADMIN']);
  });
});

describe('PrismaUserRepository: updateLockoutState', () => {
  it('failedAttempts/lockedUntilのみを更新する', async () => {
    const update = vi.fn().mockResolvedValue(makeUser());
    const prisma = { user: { findUnique: vi.fn(), update } } as unknown as MockPrismaClient;
    const repo = new PrismaUserRepository(prisma as PrismaClient);

    const lockedUntil = new Date('2026-10-07T10:00:00Z');
    await repo.updateLockoutState('u-1', { failedAttempts: 3, lockedUntil });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { failedAttempts: 3, lockedUntil },
    });
  });

  it('ロック解除（lockedUntil: null）も正しく渡される', async () => {
    const update = vi.fn().mockResolvedValue(makeUser());
    const prisma = { user: { findUnique: vi.fn(), update } } as unknown as MockPrismaClient;
    const repo = new PrismaUserRepository(prisma as PrismaClient);

    await repo.updateLockoutState('u-1', { failedAttempts: 0, lockedUntil: null });

    expect(update).toHaveBeenCalledWith({
      where: { id: 'u-1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });
});
EOF

# ============================================================
# 3. apps/web: Prisma Client を実schemaから生成
#    （本ステップはユーザーの実Cloud Shell環境でのみ実行可能。
#      Claude自身のサンドボックスは binaries.prisma.sh への
#      アウトバウンドがネットワーク許可リスト外のため
#      `prisma generate` を実行できなかった。そのため本バッチの
#      ロジック検証は、schema.prisma を手動で型として再現した
#      スタブ型に対して行った。実際の型照合はこのステップの後、
#      下記tscで確定する。）
# ============================================================
(cd packages/db && npx prisma generate)

# ============================================================
# 4. インストール＋検証
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

echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit)

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
