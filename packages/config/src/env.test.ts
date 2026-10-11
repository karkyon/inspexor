import { describe, it, expect, beforeEach } from 'vitest';
import { loadEnv, resetEnvCacheForTest } from './env';

const BASE_ENV: NodeJS.ProcessEnv = {
  APP_ENV: 'dev',
  FIRESTORE_PROJECT_ID: 'inspexor-dev',
  AUTH_SECRET: 'x'.repeat(32),
  APP_ORIGIN: 'https://inspexor-web-example.run.app',
  STORAGE_BUCKET: 'inspexor-dev-bucket',
  TASKS_QUEUE: 'inspexor-dev-queue',
  WORKER_URL: 'https://inspexor-worker-example.run.app',
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GMAIL_REFRESH_TOKEN: 'refresh-token',
  DAILY_TEMPLATE_ID: 'tmpl-daily',
  INVOICE_DETAIL_TEMPLATE_ID: 'tmpl-invoice-detail',
  INVOICE_COVER_TEMPLATE_ID: 'tmpl-invoice-cover',
};

describe('env: インフラ・運用設計書 §9 環境変数完全台帳 準拠', () => {
  beforeEach(() => {
    resetEnvCacheForTest();
  });

  it('必須項目が揃っていれば既定値込みでparseされる', () => {
    const env = loadEnv(BASE_ENV);
    expect(env.JOB_MAX_ATTEMPTS).toBe(5);
    expect(env.SIGNED_URL_TTL_SECONDS).toBe(600);
    expect(env.TZ).toBe('UTC');
    expect(env.BUSINESS_TIMEZONE).toBe('Asia/Tokyo');
    expect(env.BILLING_ALGORITHM_VERSION).toBe('BILL-2026-09-05');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('必須項目が欠落していると例外', () => {
    const broken = { ...BASE_ENV };
    delete (broken as Record<string, unknown>).AUTH_SECRET;
    expect(() => loadEnv(broken)).toThrow();
  });

  it('JOB_MAX_ATTEMPTSが5以外なら例外（台帳の固定値制約）', () => {
    const broken = { ...BASE_ENV, JOB_MAX_ATTEMPTS: '3' };
    expect(() => loadEnv(broken)).toThrow();
  });
});
