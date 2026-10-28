/**
 * worker エントリポイント（CHG-006: Firestore）。
 *   WORKER_MODE=poll（既定、開発）: 常駐して WORKER_POLL_MS ごとに outbox / 帳票 / メールを処理
 *   WORKER_MODE=http（本番 Cloud Run）: POST /run で仕事が無くなるまで処理して応答する（仕事が無ければすぐ応答）。
 *                                     web が確定直後に起動し、Cloud Scheduler が15分ごとに取りこぼしを拾う（CHG-016）
 *                                     （Cloud Run の IAM で認証。使わない時は 0 台）
 *
 *   FIRESTORE_PROJECT_ID 必須（FIRESTORE_DATABASE_ID 任意、FIRESTORE_EMULATOR_HOST で試験用エミュレータ）
 *   STORAGE_BUCKET       本番は Cloud Storage。未設定なら STORAGE_DIR（既定 ~/.inspexor-storage、開発用）
 *   MAILPIT_URL / MAIL_FROM  日報メール（CHG-004 で既定無効。DAILY_MAIL_ENABLED=true のときだけ。開発用 Mailpit adapter）
 *   CHROMIUM_PATH        任意（未指定なら Playwright の既定ブラウザ）
 *   PORT                 http モードの待受（Cloud Run は 8080）
 */
import { createServer } from 'node:http';
import { FirestoreDocStore, storageFromEnv } from '@inspexor/docstore';
import { isDailyMailEnabled } from '@inspexor/domain';
import { ChromiumPdfRenderer } from './adapters/chromium-pdf';
import { MailpitMailSender } from './adapters/mailpit-mail';
import { drain, runOnce, type WorkerDeps } from './worker';

const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('[worker] FIRESTORE_PROJECT_ID が未設定です');
  process.exit(1);
}
const databaseId = process.env['FIRESTORE_DATABASE_ID'];
const store = new FirestoreDocStore({ projectId, ...(databaseId ? { databaseId } : {}) });
const pdf = new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']);
const deps: WorkerDeps = {
  store,
  pdf,
  storage: storageFromEnv(),
  sender: new MailpitMailSender(process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025', process.env['MAIL_FROM'] ?? 'inspexor-dev@example.invalid'),
  now: () => new Date(),
  dailyMailEnabled: isDailyMailEnabled(process.env['DAILY_MAIL_ENABLED']),
};
const mode = process.env['WORKER_MODE'] ?? 'poll';
let stopping = false;

async function shutdown(): Promise<void> {
  await pdf.close();
  await store.close();
}

if (mode === 'http') {
  // 1回の起動で処理する時間の上限（Cloud Run の timeout より短く）
  const budgetMs = Number(process.env['WORKER_BUDGET_MS'] ?? '240000');
  let running: Promise<unknown> | null = null;
  const server = createServer((req, res) => {
    // Cloud Run は末尾が z のパス（/healthz 等）を予約しているため /health（g26）
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/run') {
      res.writeHead(404).end();
      return;
    }
    // 同じ instance での同時実行はしない（Firestore の transaction で二重処理は防げるが、Chromium を1つで使うため）
    if (running !== null) {
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'busy' }));
      return;
    }
    const run = drain(deps, budgetMs);
    running = run;
    run
      .then((r) => {
        if (r.dispatched + r.documents + r.mails > 0) console.log(`[worker] rounds=${r.rounds} dispatched=${r.dispatched} documents=${r.documents} mails=${r.mails}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r));
      })
      .catch((error: unknown) => {
        console.error('[worker] run error', error instanceof Error ? error.message : String(error));
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'error' }));
      })
      .finally(() => {
        running = null;
      });
  });
  const port = Number(process.env['PORT'] ?? '8080');
  server.listen(port, () => console.log(`[worker] http mode（POST /run, port ${port}）`));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      server.close();
      void shutdown().finally(() => process.exit(0));
    });
  }
} else {
  const interval = Number(process.env['WORKER_POLL_MS'] ?? '5000');
  const loop = async (): Promise<void> => {
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
    await shutdown();
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      stopping = true;
    });
  }
  void loop();
}
