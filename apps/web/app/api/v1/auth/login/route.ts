import { PrismaUserRepository } from '../../../../../lib/auth/prisma-user-repository';
import { Argon2PasswordHasher } from '../../../../../lib/auth/argon2-password-hasher';
import { handleLoginRequest } from '../../../../../lib/auth/login-handler';
import { prisma } from '../../../../../lib/db/prisma-client';
import { getSessionSecret } from '../../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request, {
    userRepository: new PrismaUserRepository(prisma),
    passwordHasher: new Argon2PasswordHasher(),
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
