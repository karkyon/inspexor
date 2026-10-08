import { getPool } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { getSessionSecret } from '../auth/session-secret';
import { MasterService } from './master-service';
import type { MasterRouteDeps } from './master-handlers';

export const masterRouteDeps: MasterRouteDeps = {
  service: () => new MasterService(getPool()),
  api: () => ({
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    auditRepository: new PgAuditRepository(getPool()),
  }),
};
