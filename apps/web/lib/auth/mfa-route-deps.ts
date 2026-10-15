/** CHG-012 多要素認証・再認証の API の依存（アプリ用） */
import { getDocStore } from '../db/docstore';
import { appApiDeps } from '../http/app-api-deps';
import { createLoginRateLimit } from '../security/rate-limit';
import { Argon2PasswordHasher } from './argon2-password-hasher';
import { MfaService } from './mfa-service';
import { getSessionSecret } from './session-secret';
import type { MfaAccountDeps, MfaPublicDeps } from './mfa-handlers';

const rateLimit = createLoginRateLimit(() => getDocStore());
const service = () => new MfaService(getDocStore(), getSessionSecret());

export const mfaPublicDeps: MfaPublicDeps = { service, sessionSecret: getSessionSecret, now: () => new Date(), rateLimit };
export const mfaAccountDeps: MfaAccountDeps = { service, hasher: () => new Argon2PasswordHasher(), api: appApiDeps, rateLimit };
