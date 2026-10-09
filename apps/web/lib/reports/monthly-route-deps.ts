import { getPool } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { getSessionSecret } from '../auth/session-secret';
import type { MonthlyRouteDeps } from './monthly-handlers';

export const monthlyRouteDeps: MonthlyRouteDeps = {
  pool: () => getPool(),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new PgAuditRepository(getPool()) }),
};
