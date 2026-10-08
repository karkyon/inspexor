import { randomUUID } from 'node:crypto';

// openapi Error.correlationId は format: uuid。受信ヘッダがUUIDでなければ新規発行する。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export function resolveCorrelationId(request: Request): string {
  const incoming = request.headers.get(CORRELATION_ID_HEADER);
  return incoming !== null && UUID_PATTERN.test(incoming) ? incoming.toLowerCase() : randomUUID();
}
