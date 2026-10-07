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
