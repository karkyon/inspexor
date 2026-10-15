import { appApiDeps } from '../http/app-api-deps';
import { featureFlags } from '@inspexor/domain';
import { getDocStore } from '../db/docstore';
import { MasterService } from './master-service';
import type { MasterRouteDeps } from './master-handlers';

export const masterRouteDeps: MasterRouteDeps = {
  service: () => new MasterService(getDocStore(), { billing: featureFlags(process.env).billing }),
  api: appApiDeps,
};
