import { appApiDeps } from '../http/app-api-deps';
import { DocIdempotencyRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { getSessionSecret } from '../auth/session-secret';
import { AdjustmentService } from './adjustment-service';
import { BillingService } from './billing-service';
import { InvoiceService } from './invoice-service';
import type { BillingRouteDeps } from './billing-handlers';

export const billingRouteDeps: BillingRouteDeps = {
  service: () => new BillingService(getDocStore()),
  invoices: () => new InvoiceService(getDocStore(), getSessionSecret()),
  adjustments: () => new AdjustmentService(getDocStore()),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: appApiDeps,
};
