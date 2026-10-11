import { DocIdempotencyRepository, StoreAuditRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { appUserGuard } from '../auth/app-user-guard';
import { BillingService } from './billing-service';
import type { BillingRouteDeps } from './billing-handlers';

export const billingRouteDeps: BillingRouteDeps = {
  service: () => new BillingService(getDocStore()),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: () => ({ sessionSecret: getSessionSecret(), now: () => new Date(), auditRepository: new StoreAuditRepository(getDocStore()), userGuard: appUserGuard }),
};
