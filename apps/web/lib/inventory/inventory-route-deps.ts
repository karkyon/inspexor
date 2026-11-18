import { DocIdempotencyRepository } from '@inspexor/docstore';
import { appApiDeps } from '../http/app-api-deps';
import { getDocStore } from '../db/docstore';
import { InventoryService } from './inventory-service';
import type { InventoryRouteDeps } from './inventory-handlers';

export const inventoryRouteDeps: InventoryRouteDeps = {
  service: () => new InventoryService(getDocStore()),
  idempotency: () => new DocIdempotencyRepository(getDocStore()),
  api: appApiDeps,
};
