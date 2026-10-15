import { mfaAccountHandlers } from '../../../../../lib/auth/mfa-handlers';
import { mfaAccountDeps } from '../../../../../lib/auth/mfa-route-deps';

export const dynamic = 'force-dynamic';

// CHG-012 API-041
const handlers = mfaAccountHandlers(mfaAccountDeps);

export async function GET(request: Request): Promise<Response> {
  return handlers.status(request);
}
