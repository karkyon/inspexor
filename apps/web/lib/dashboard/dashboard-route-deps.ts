import { StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import type { DashboardRouteDeps } from './dashboard-handlers';

export const dashboardRouteDeps: DashboardRouteDeps = {
  store: () => getDocStore(),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new StoreAuditRepository(getDocStore()) }),
};
