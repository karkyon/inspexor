/**
 * 統合テスト用: ITEST_DATABASE_URL（管理DBへの接続URL）上に空DBを作り、仕様正本 schema.sql を適用する。
 * G1 Exit「fresh DB」= 毎回 schema.sql だけから構築したDBで検証する。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readdirSync as listDir } from 'node:fs';
import { Pool } from 'pg';

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml が見つかりません');
    dir = parent;
  }
}

export function findSpecFile(fileName: string, envVar: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const root = findRepoRoot(process.cwd());
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', '.git', 'dist'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === fileName) return full;
    }
  }
  throw new Error(`${fileName} がリポジトリ内に見つかりません`);
}

export interface FreshDatabase {
  readonly pool: Pool;
  readonly name: string;
  drop(): Promise<void>;
}

export async function createFreshDatabase(label: string): Promise<FreshDatabase> {
  const adminUrl = process.env['ITEST_DATABASE_URL'];
  if (!adminUrl) {
    throw new Error('ITEST_DATABASE_URL が未設定です（例: postgresql://postgres:test@127.0.0.1:5433/postgres）');
  }
  const name = `itest_${label}_${process.pid}_${Date.now()}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 5 });
  // DROP DATABASE ... WITH (FORCE) で切断された idle 接続の error を握る（試験終了処理のみ）
  pool.on('error', () => undefined);
  const schemaPath = findSpecFile('schema.sql', 'SCHEMA_SQL_PATH');
  await pool.query(readFileSync(schemaPath, 'utf8'));
  // 追記migration（docs/spec/migrations/*.sql、rollback除く）を番号順に適用
  const migrationsDir = join(dirname(schemaPath), 'migrations');
  if (existsSync(migrationsDir)) {
    const files = listDir(migrationsDir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.rollback.sql'))
      .sort();
    for (const file of files) {
      await pool.query(readFileSync(join(migrationsDir, file), 'utf8'));
    }
  }

  return {
    pool,
    name,
    async drop() {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export async function insertUser(pool: Pool, loginId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO app.users (login_id, password_hash, display_name) VALUES ($1, 'x', $1) RETURNING id`,
    [loginId],
  );
  return result.rows[0]?.id as string;
}
