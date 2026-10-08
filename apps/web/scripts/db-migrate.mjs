// docs/spec/migrations/*.sql（rollback除く）を未適用分だけ番号順に DATABASE_URL へ適用する。
// 各migrationファイルは自身で BEGIN/COMMIT と app.schema_migrations への記録を行う（失敗時は全体rollback）。
//   node --env-file=.env.local scripts/db-migrate.mjs [--dry-run]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', '..', '..', 'docs', 'spec', 'migrations');
const dryRun = process.argv.includes('--dry-run');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が未設定です。');
  process.exit(1);
}
const files = readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql')).sort();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const exists = await client.query(`SELECT to_regclass('app.schema_migrations') IS NOT NULL AS ok`);
  const applied = new Set(
    exists.rows[0].ok ? (await client.query('SELECT id FROM app.schema_migrations')).rows.map((r) => r.id) : [],
  );
  let count = 0;
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (applied.has(id)) {
      console.log(`skip    ${id}（適用済み）`);
      continue;
    }
    if (dryRun) {
      console.log(`pending ${id}`);
      continue;
    }
    try {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      console.log(`applied ${id}`);
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`FAILED  ${id}: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
      break;
    }
  }
  if (process.exitCode !== 1) console.log(dryRun ? 'dry-run 完了' : `migration 完了（新規適用 ${count} 件）`);
} finally {
  await client.end();
}
