// CHG-013 マスタ・利用者の一括登録用の Excel を作る（データベースには触れない）。
//   npx tsx scripts/masters-template.ts <出力.xlsx> [--sample]
//     --sample: 試験用データ一式（TEST- で始まるお客様・品番・作業者・利用者など）を記入済みで作る
import { writeFileSync } from 'node:fs';
import { writeTemplate } from '../lib/import/xlsx';

const out = process.argv[2];
if (!out || !out.endsWith('.xlsx')) {
  console.error('使い方: npx tsx scripts/masters-template.ts <出力.xlsx> [--sample]');
  process.exit(1);
}
const sample = process.argv.includes('--sample');
writeFileSync(out, await writeTemplate(sample));
console.log(`${sample ? '試験用データ一式（記入済み）' : '記入用テンプレート'}を作成しました: ${out}`);
