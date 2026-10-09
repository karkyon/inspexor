import { recordTransitionHandlers } from '../../../../../../../lib/field/field-handlers';
import { fieldRouteDeps } from '../../../../../../../lib/field/field-route-deps';

const handlers = recordTransitionHandlers(fieldRouteDeps);

// API-013 transitionRecord（CHG-004: revise のみ。承認系は対象外）
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
