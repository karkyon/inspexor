/** 仕様正本ファイル（openapi.yaml 等）をリポジトリ内から探す（DB に依存しない試験用） */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
