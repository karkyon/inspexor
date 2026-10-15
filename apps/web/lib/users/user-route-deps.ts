import { appApiDeps } from '../http/app-api-deps';
import { getDocStore } from '../db/docstore';
import { Argon2PasswordHasher } from '../auth/argon2-password-hasher';
import { UserService } from './user-service';
import type { UserRouteDeps } from './user-handlers';

const hasher = new Argon2PasswordHasher();

export const userRouteDeps: UserRouteDeps = {
  service: () => new UserService(getDocStore(), (p) => hasher.hash(p)),
  api: appApiDeps,
};
