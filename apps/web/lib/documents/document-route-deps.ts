import { appApiDeps } from '../http/app-api-deps';
import { isDailyMailEnabled } from '@inspexor/domain';
import { DocIdempotencyRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { DocumentService } from './document-service';
import type { DocumentRouteDeps } from './document-handlers';

export const documentRouteDeps: DocumentRouteDeps = {
  service: () => new DocumentService(getDocStore(), getSessionSecret(), isDailyMailEnabled(process.env['DAILY_MAIL_ENABLED'])),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: appApiDeps,
};
