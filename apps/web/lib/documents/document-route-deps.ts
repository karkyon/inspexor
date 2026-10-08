import { getPool } from '../db/pg';
import { PgAuditRepository } from '../db/pg-audit-repository';
import { getSessionSecret } from '../auth/session-secret';
import { DocumentService } from './document-service';
import type { DocumentRouteDeps } from './document-handlers';

export const documentRouteDeps: DocumentRouteDeps = {
  service: () => new DocumentService(getPool(), getSessionSecret()),
  pool: () => getPool(),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new PgAuditRepository(getPool()) }),
};
