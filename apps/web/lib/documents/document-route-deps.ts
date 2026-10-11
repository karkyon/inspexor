import { isDailyMailEnabled } from '@inspexor/domain';
import { DocIdempotencyRepository, StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { DocumentService } from './document-service';
import type { DocumentRouteDeps } from './document-handlers';
import { appUserGuard } from '../auth/app-user-guard';

export const documentRouteDeps: DocumentRouteDeps = {
  service: () => new DocumentService(getDocStore(), getSessionSecret(), isDailyMailEnabled(process.env['DAILY_MAIL_ENABLED'])),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new StoreAuditRepository(getDocStore()), userGuard: appUserGuard }),
};
