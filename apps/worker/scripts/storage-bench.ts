/**
 * Cloud Storage 読出しの方式比較（g25a。業務データは作らない。試験用の object は最後に削除）。
 *   旧: SDK の download()（g24b までの読み戻し。1要求30秒打ち切り・再試行あり）
 *   旧（毎回新しい接続）: 同じ download() を、毎回 Storage を作り直して実行（接続の使い回しの影響を見る）
 *   新: fetch で JSON API を直接呼ぶ get（web の PDF 表示・メール添付が使う）
 *   新: stat（保存先が計算したサイズ・MD5 のみ取得。worker の保存直後の照合が使う）
 * 各回の前に 8 秒待つ（接続が使われずに置かれた状態を作る。g24b の遅延はこの状態で起きていた可能性がある）。
 * 1要求 35 秒で計測を打ち切り「打切」と表示する。
 * 実行: cd apps/worker && npx tsx --env-file=../web/.env.local scripts/storage-bench.ts
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { GcsStorage, md5Base64 } from '@inspexor/docstore';

const bucket = process.env['STORAGE_BUCKET'];
if (!bucket) {
  console.error('STORAGE_BUCKET が未設定です');
  process.exit(1);
}
const ROUNDS = 5;
const CAP_MS = 35_000;
const sdkOptions = { timeout: 30_000, retryOptions: { maxRetries: 3, maxRetryDelay: 8, totalTimeout: 60 } };
const sdk = new Storage(sdkOptions);
const adapter = new GcsStorage(bucket);
const bytes = randomBytes(300 * 1024);
const md5 = md5Base64(bytes);
const keys: string[] = [];

type Result = { ms: number; ok: boolean; note?: string };
async function measure(fn: () => Promise<boolean>): Promise<Result> {
  const t = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const ok = await Promise.race([
      fn(),
      new Promise<boolean>((_, rej) => {
        timer = setTimeout(() => rej(new Error('cap')), CAP_MS);
      }),
    ]);
    return { ms: Date.now() - t, ok };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ms: Date.now() - t, ok: false, note: msg === 'cap' ? '打切' : msg.slice(0, 80) };
  } finally {
    clearTimeout(timer);
  }
}

const methods: Array<[string, (key: string) => Promise<boolean>]> = [
  ['新 get（fetch）', async (k) => (await adapter.get(k)).bytes.equals(bytes)],
  ['新 stat（MD5 照合）', async (k) => (await adapter.stat(k)).md5Base64 === md5],
  ['旧 download（SDK）', async (k) => (await sdk.bucket(bucket).file(k).download())[0].equals(bytes)],
  ['旧 download（毎回新しい接続）', async (k) => (await new Storage(sdkOptions).bucket(bucket).file(k).download())[0].equals(bytes)],
];
const results = new Map<string, Result[]>(methods.map(([n]) => [n, []]));
const puts: number[] = [];

try {
  for (let round = 1; round <= ROUNDS; round += 1) {
    const key = `_bench/${randomUUID()}.bin`;
    keys.push(key);
    const t = Date.now();
    await adapter.put(key, bytes, 'application/octet-stream');
    puts.push(Date.now() - t);
    for (const [name, fn] of methods) {
      await new Promise((r) => setTimeout(r, 8_000));
      const r = await measure(() => fn(key));
      results.get(name)?.push(r);
    }
    process.stdout.write(`  ${round}/${ROUNDS} 回目 完了\n`);
  }
  console.log(`保存（put、300KB）              ${puts.map((v) => `${v}ms`).join(' / ')}`);
  for (const [name] of methods) {
    const rs = results.get(name) ?? [];
    const cells = rs.map((r) => (r.ok ? `${r.ms}ms` : `${r.ms}ms(${r.note ?? '内容不一致'})`));
    const max = Math.max(...rs.map((r) => r.ms));
    console.log(`${name.padEnd(26)} ${cells.join(' / ')}  最大 ${max}ms${rs.every((r) => r.ok) ? '' : '  ※失敗あり'}`);
  }
  const newMax = Math.max(...(results.get('新 get（fetch）') ?? []).map((r) => r.ms), ...(results.get('新 stat（MD5 照合）') ?? []).map((r) => r.ms));
  const newOk = [...(results.get('新 get（fetch）') ?? []), ...(results.get('新 stat（MD5 照合）') ?? [])].every((r) => r.ok);
  console.log(`判定: 新方式 ${newOk && newMax < 5_000 ? 'OK' : 'NG'}（全件成功かつ最大 5 秒未満で OK。最大 ${newMax}ms）`);
  process.exitCode = newOk && newMax < 5_000 ? 0 : 2;
} finally {
  await Promise.all(keys.map((k) => sdk.bucket(bucket).file(k).delete({ ignoreNotFound: true }).catch(() => undefined)));
}
// 打ち切った SDK の要求が裏で再試行を続けるため、待たずに終了する
setTimeout(() => process.exit(), 100).unref();
process.on('beforeExit', () => process.exit());
