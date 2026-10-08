import { getPool } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { getSessionSecret } from '../auth/session-secret';
import { FieldReportService } from './field-report-service';
import type { FieldRouteDeps } from './field-handlers';

export const fieldRouteDeps: FieldRouteDeps = {
  service: () => new FieldReportService(getPool()),
  pool: () => getPool(),
  api: () => ({
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    auditRepository: new PgAuditRepository(getPool()),
  }),
};
