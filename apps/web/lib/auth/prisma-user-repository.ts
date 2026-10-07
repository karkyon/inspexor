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
