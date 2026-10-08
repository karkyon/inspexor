import { CORRELATION_ID_HEADER } from './correlation-id';

export interface ErrorField {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ErrorOptions {
  readonly retryable?: boolean;
  readonly fields?: readonly ErrorField[];
  readonly setCookie?: string;
  /** API設計書 §共通例: 409 の currentVersion / changedFields 等 */
  readonly extra?: Readonly<Record<string, unknown>>;
}

// openapi components.schemas.Error 準拠: {error:{code,message,correlationId,retryable,fields?}}
export function errorResponse(
  status: number,
  code: string,
  message: string,
  correlationId: string,
  options: ErrorOptions = {},
): Response {
  const response = Response.json(
    {
      error: {
        code,
        message,
        correlationId,
        retryable: options.retryable ?? false,
        ...(options.fields !== undefined ? { fields: options.fields } : {}),
        ...(options.extra ?? {}),
      },
    },
    { status, headers: { [CORRELATION_ID_HEADER]: correlationId } },
  );
  if (options.setCookie !== undefined) {
    response.headers.append('Set-Cookie', options.setCookie);
  }
  return response;
}

export function dataResponse(status: number, data: unknown, correlationId: string, setCookie?: string): Response {
  const response = Response.json({ data, meta: null }, { status, headers: { [CORRELATION_ID_HEADER]: correlationId } });
  if (setCookie !== undefined) {
    response.headers.append('Set-Cookie', setCookie);
  }
  return response;
}
