import { StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import type { MonthlyRouteDeps } from './monthly-handlers';

export const monthlyRouteDeps: MonthlyRouteDeps = {
  store: () => getDocStore(),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new StoreAuditRepository(getDocStore()) }),
};
