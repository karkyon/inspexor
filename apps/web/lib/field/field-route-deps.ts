import { DocIdempotencyRepository, StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { FieldReportService } from './field-report-service';
import type { FieldRouteDeps } from './field-handlers';

export const fieldRouteDeps: FieldRouteDeps = {
  service: () => new FieldReportService(getDocStore()),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: () => ({
    sessionSecret: getSessionSecret(),
    now: () => new Date(),
    auditRepository: new StoreAuditRepository(getDocStore()),
  }),
};
