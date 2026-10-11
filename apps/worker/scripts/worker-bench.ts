/**
 * worker の各工程の所要時間を測る（CHG-006 g24b。帳票生成が遅いときの切り分け用。業務データは作らない）。
 *   Firestore: 単純読込 ×5、transaction（読込＋書込）×3   … _health/bench を使う
 *   Cloud Storage: 300KB の保存 → 読み戻し ×3（試験用の object は最後に削除）
 *   Chromium: 作業日報 V2 の様式を PDF 化 ×3（1回目はブラウザ起動を含む）
 * 実行: cd apps/worker && npx tsx --env-file=../web/.env.local scripts/worker-bench.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { FirestoreDocStore, storageFromEnv } from '@inspexor/docstore';
import { ChromiumPdfRenderer } from '../src/adapters/chromium-pdf';
import { loadFixtureTemplate } from '../src/templates';

const projectId = process.env['FIRESTORE_PROJECT_ID'];
if (!projectId) {
  console.error('FIRESTORE_PROJECT_ID が未設定です');
  process.exit(1);
}

async function timed(label: string, n: number, fn: (i: number) => Promise<unknown>): Promise<void> {
  const ms: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = Date.now();
    await fn(i);
    ms.push(Date.now() - t);
  }
  console.log(`${label.padEnd(28)} ${ms.map((v) => `${v}ms`).join(' / ')}`);
}

const store = new FirestoreDocStore({ projectId, ...(process.env['FIRESTORE_DATABASE_ID'] ? { databaseId: process.env['FIRESTORE_DATABASE_ID'] } : {}) });
const storage = storageFromEnv();
const pdf = new ChromiumPdfRenderer(process.env['CHROMIUM_PATH']);
const bucket = process.env['STORAGE_BUCKET'];
const keys: string[] = [];

try {
  await timed('Firestore 読込', 5, () => store.get('_health/ping'));
  await timed('Firestore transaction', 3, () =>
    store.runTransaction(async (tx) => {
      const d = await tx.get<{ n: number }>('_health/bench');
      tx.set('_health/bench', { n: (d?.n ?? 0) + 1, at: new Date() });
    }),
  );
  const bytes = randomBytes(300 * 1024);
  await timed(`Storage 保存（${bucket ? 'GCS' : 'ローカル'}、300KB）`, 3, async () => {
    const key = `_bench/${randomUUID()}.bin`;
    keys.push(key);
    await storage.put(key, bytes, 'application/octet-stream');
  });
  await timed('Storage 読み戻し（get）', 3, (i) => storage.get(keys[i] as string));
  await timed('Storage 照合（stat）', 3, (i) => storage.stat(keys[i] as string));
  const html = loadFixtureTemplate('DAILY_REPORT_V2').html;
  await timed('Chromium PDF 化（作業日報 V2）', 3, () => pdf.render(html));
} finally {
  if (bucket) {
    const gcs = new Storage();
    await Promise.all(keys.map((k) => gcs.bucket(bucket).file(k).delete({ ignoreNotFound: true }).catch(() => undefined)));
  }
  await pdf.close();
  await store.close();
}
