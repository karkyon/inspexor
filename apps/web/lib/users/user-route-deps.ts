import { StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { appUserGuard } from '../auth/app-user-guard';
import { Argon2PasswordHasher } from '../auth/argon2-password-hasher';
import { UserService } from './user-service';
import type { UserRouteDeps } from './user-handlers';

const hasher = new Argon2PasswordHasher();

export const userRouteDeps: UserRouteDeps = {
  service: () => new UserService(getDocStore(), (p) => hasher.hash(p)),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new StoreAuditRepository(getDocStore()), userGuard: appUserGuard }),
};
