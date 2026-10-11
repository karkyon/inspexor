// CHG-006: Cloud Storage adapter の実接続確認（保存 → 読出し → hash 照合 → 削除）。秘密情報は表示しない。
// 実行: STORAGE_BUCKET=... npx tsx scripts/storage-smoke.ts
import { createHash, randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { GcsStorage, StorageError } from '@inspexor/docstore';

const bucket = process.env['STORAGE_BUCKET'];
if (!bucket) {
  console.error('STORAGE_BUCKET が未設定です。');
  process.exit(1);
}
const key = `smoke/${randomUUID()}/試験.pdf`;
const bytes = Buffer.from(`%PDF-1.7\n% inspexor storage smoke ${new Date().toISOString()}\n%%EOF`);
const storage = new GcsStorage(bucket);
let failed = false;
try {
  await storage.put(key, bytes, 'application/pdf');
  const back = await storage.get(key);
  const same = createHash('sha256').update(back.bytes).digest('hex') === createHash('sha256').update(bytes).digest('hex');
  console.log(`保存・読出し: ${same ? 'OK（hash 一致）' : 'NG（hash 不一致）'}`);
  failed ||= !same;
  try {
    await storage.get(`smoke/${randomUUID()}/none.pdf`);
    console.log('存在しない key: NG（読めてしまった）');
    failed = true;
  } catch (error) {
    const ok = error instanceof StorageError && error.code === 'NOT_FOUND';
    console.log(`存在しない key: ${ok ? 'OK（NOT_FOUND）' : `NG（${String(error)}）`}`);
    failed ||= !ok;
  }
  const [meta] = await new Storage().bucket(bucket).getMetadata();
  const pap = meta.iamConfiguration?.publicAccessPrevention;
  const ubla = meta.iamConfiguration?.uniformBucketLevelAccess?.enabled;
  console.log(`バケット設定: 公開禁止=${pap ?? '(不明)'} 均一アクセス=${String(ubla)} 場所=${meta.location ?? '(不明)'}`);
  failed ||= pap !== 'enforced' || ubla !== true;
} catch (error) {
  failed = true;
  console.error('Cloud Storage 接続失敗:', error instanceof Error ? error.message : error);
} finally {
  await new Storage().bucket(bucket).file(key).delete({ ignoreNotFound: true }).catch(() => undefined);
}
process.exitCode = failed ? 1 : 0;
