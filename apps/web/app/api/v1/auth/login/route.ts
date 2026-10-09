import { DocUserRepository } from '@inspexor/docstore';
import { Argon2PasswordHasher } from '../../../../../lib/auth/argon2-password-hasher';
import { handleLoginRequest } from '../../../../../lib/auth/login-handler';
import { getDocStore } from '../../../../../lib/db/docstore';
import { getSessionSecret } from '../../../../../lib/auth/session-secret';

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request, {
    userRepository: new DocUserRepository(getDocStore()),
    passwordHasher: new Argon2PasswordHasher(),
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
  });
}
