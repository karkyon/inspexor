import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.APP_ENV === 'local' ? ['warn', 'error'] : ['warn', 'error'],
  });

if (process.env.APP_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
