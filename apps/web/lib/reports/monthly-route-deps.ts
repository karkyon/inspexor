import { appApiDeps } from '../http/app-api-deps';
import { getDocStore } from '../db/docstore';
import type { MonthlyRouteDeps } from './monthly-handlers';

export const monthlyRouteDeps: MonthlyRouteDeps = {
  store: () => getDocStore(),
  api: appApiDeps,
};
