import { StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { MasterService } from './master-service';
import type { MasterRouteDeps } from './master-handlers';

export const masterRouteDeps: MasterRouteDeps = {
  service: () => new MasterService(getDocStore()),
  api: () => ({
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    auditRepository: new StoreAuditRepository(getDocStore()),
  }),
};
