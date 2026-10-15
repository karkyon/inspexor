import { appApiDeps } from '../http/app-api-deps';
import { DocIdempotencyRepository } from '@inspexor/docstore';
import { getDocStore } from '../db/docstore';
import { FieldReportService } from './field-report-service';
import type { FieldRouteDeps } from './field-handlers';

export const fieldRouteDeps: FieldRouteDeps = {
  service: () => new FieldReportService(getDocStore()),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: appApiDeps,
};
