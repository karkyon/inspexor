import { DocUserRepository } from '@inspexor/docstore';
import { Argon2PasswordHasher } from '../../../../../lib/auth/argon2-password-hasher';
import { handleLoginRequest } from '../../../../../lib/auth/login-handler';
import { MfaService } from '../../../../../lib/auth/mfa-service';
import { getDocStore } from '../../../../../lib/db/docstore';
import { getSessionSecret } from '../../../../../lib/auth/session-secret';
import { createLoginRateLimit } from '../../../../../lib/security/rate-limit';

// 認証・データ参照を伴うため常に実行時に処理する（ビルド時の事前生成をしない）
export const dynamic = 'force-dynamic';

const rateLimit = createLoginRateLimit(() => getDocStore());

export async function POST(request: Request): Promise<Response> {
  return handleLoginRequest(request, {
    userRepository: new DocUserRepository(getDocStore()),
    passwordHasher: new Argon2PasswordHasher(),
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    rateLimit,
    mfa: new MfaService(getDocStore(), getSessionSecret()),
  });
}
