/**
 * INSPEXOR_インフラ・運用設計書_v5.1.md §9 環境変数完全台帳 準拠。
 * 固定値（JOB_MAX_ATTEMPTS=5、SIGNED_URL_TTL_SECONDS=600、TZ=UTC、
 * BUSINESS_TIMEZONE=Asia/Tokyo、BILLING_ALGORITHM_VERSION=BILL-2026-09-05）は
 * 台帳の「値=X」列どおりrefineで固定する。
 */
import { z } from 'zod';

const envSchema = z.object({
  APP_ENV: z.enum(['local', 'dev', 'stg', 'prod']),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.string().url(),
  STORAGE_BUCKET: z.string().min(1),
  TASKS_QUEUE: z.string().min(1),
  WORKER_URL: z.string().url(),
  GMAIL_CLIENT_ID: z.string().min(1),
  GMAIL_CLIENT_SECRET: z.string().min(1),
  GMAIL_REFRESH_TOKEN: z.string().min(1),
  DAILY_TEMPLATE_ID: z.string().min(1),
  INVOICE_DETAIL_TEMPLATE_ID: z.string().min(1),
  INVOICE_COVER_TEMPLATE_ID: z.string().min(1),
  LOG_LEVEL: z.enum(['info', 'warn', 'error']).default('info'),
  SENTRY_DSN: z.string().url().optional(),
  JOB_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .refine((v) => v === 5, { message: 'JOB_MAX_ATTEMPTSは5固定（環境変数完全台帳準拠）' })
    .default(5),
  SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .refine((v) => v === 600, { message: 'SIGNED_URL_TTL_SECONDSは600固定（環境変数完全台帳準拠）' })
    .default(600),
  TZ: z.literal('UTC').default('UTC'),
  BUSINESS_TIMEZONE: z.literal('Asia/Tokyo').default('Asia/Tokyo'),
  BILLING_ALGORITHM_VERSION: z.string().min(1).default('BILL-2026-09-05'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`環境変数の検証に失敗しました: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCacheForTest(): void {
  cached = undefined;
}
