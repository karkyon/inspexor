#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

# ============================================================
# 1. apps/web: @prisma/client を直接依存として追加
#    （pnpmはhoistしないため、packages/dbにあるだけではapps/webから
#      モジュール解決できない。TS2307 Cannot find module '@prisma/client' の原因）
# ============================================================
cd apps/web
pnpm add "@prisma/client@^5.20.0"
cd ~/inspexor

# ============================================================
# 2. apps/web/tsconfig.json が "files"（静的リスト）方式のため、
#    新規追加した .ts を自動検出してリストへ追記する。
#    "include" グロブ方式ならこのスクリプトは何もしない（既に解決されるため）。
# ============================================================
node << 'NODEEOF'
const fs = require('fs');
const path = require('path');

const tsconfigPath = path.join('apps/web', 'tsconfig.json');
const raw = fs.readFileSync(tsconfigPath, 'utf8');
const config = JSON.parse(raw);

if (!Array.isArray(config.files)) {
  console.log('apps/web/tsconfig.json は "files" 方式ではないため、変更不要。');
  process.exit(0);
}

function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, results);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
}

const found = [];
for (const base of ['app', 'lib']) {
  const baseDir = path.join('apps/web', base);
  if (fs.existsSync(baseDir)) {
    walk(baseDir, found);
  }
}

const relativeToApp = found.map((p) => path.relative('apps/web', p).split(path.sep).join('/'));
const existing = new Set(config.files);
let added = 0;
for (const rel of relativeToApp) {
  if (!existing.has(rel)) {
    config.files.push(rel);
    existing.add(rel);
    added += 1;
  }
}

config.files.sort();
fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
console.log(`apps/web/tsconfig.json の files に ${added} 件追加しました。`);
NODEEOF

# ============================================================
# 3. 再検証
# ============================================================
pnpm install

echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit)

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
