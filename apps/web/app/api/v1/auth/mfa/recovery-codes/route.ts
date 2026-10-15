import { mfaAccountHandlers } from '../../../../../../lib/auth/mfa-handlers';
import { mfaAccountDeps } from '../../../../../../lib/auth/mfa-route-deps';

export const dynamic = 'force-dynamic';

// CHG-012 API-042
const handlers = mfaAccountHandlers(mfaAccountDeps);

export async function POST(request: Request): Promise<Response> {
  return handlers.regenerate(request);
}
