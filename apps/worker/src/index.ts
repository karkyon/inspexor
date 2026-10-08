/**
 * worker エントリポイント（開発環境: 常駐して outbox / 帳票 / メールを処理。本番は Cloud Tasks → Cloud Run で G9 接続）。
 *   DATABASE_URL        必須
 *   STORAGE_DIR         既定 ~/.inspexor-storage（開発用 LocalFsStorage。web の配信 route と同じ場所）
 *   MAILPIT_URL         既定 http://127.0.0.1:8025（開発用 Mailpit adapter。EXT-03 Gmail は G9）
 *   MAIL_FROM           既定 inspexor-dev@example.invalid
 *   WORKER_POLL_MS      既定 2000
 *   CHROMIUM_PATH       任意（未指定なら Playwright の既定ブラウザ）
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChromiumPdfRenderer } from './adapters/chromium-pdf';
import { LocalFsStorage } from './adapters/local-fs-storage';
import { MailpitMailSender } from './adapters/mailpit-mail';
import { createPool } from './db';
import { runOnce } from './worker';

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  console.error('[worker] DATABASE_URL が未設定です');
  process.exit(1);
}
if (process.env['STORAGE_BUCKET']) {
  // 本番 adapter（Cloud Storage）は未実装（G9: EXTERNAL-BLOCKED）。誤って開発 adapter で本番を動かさない
  console.error('[worker] STORAGE_BUCKET が設定されています。Cloud Storage adapter は G9 で接続予定のため起動しません');
  process.exit(1);
}

const pool = createPool(databaseUrl);
const pdf = new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']);
const deps = {
  pool,
  pdf,
  storage: new LocalFsStorage(process.env['STORAGE_DIR'] ?? join(homedir(), '.inspexor-storage')),
  sender: new MailpitMailSender(process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025', process.env['MAIL_FROM'] ?? 'inspexor-dev@example.invalid'),
  now: () => new Date(),
};
const interval = Number(process.env['WORKER_POLL_MS'] ?? '2000');
let stopping = false;

async function loop(): Promise<void> {
  console.log(`[worker] started（poll ${interval}ms）`);
  while (!stopping) {
    try {
      const r = await runOnce(deps);
      if (r.dispatched + r.documents.length + r.mails.length > 0) {
        console.log(`[worker] dispatched=${r.dispatched} documents=${r.documents.join(',') || '-'} mails=${r.mails.join(',') || '-'}`);
      }
    } catch (error) {
      // 内部詳細は標準エラーのみ（secret は扱わない）
      console.error('[worker] loop error', error instanceof Error ? error.message : String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  await pdf.close();
  await pool.end();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}
void loop();
