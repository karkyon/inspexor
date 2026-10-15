import { appApiDeps } from '../http/app-api-deps';
import { getDocStore } from '../db/docstore';
import type { DashboardRouteDeps } from './dashboard-handlers';

export const dashboardRouteDeps: DashboardRouteDeps = {
  store: () => getDocStore(),
  api: appApiDeps,
};
