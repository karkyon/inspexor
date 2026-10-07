#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

# ============================================================
# apps/web/tsconfig.json は "files" ではなく "include" に実ファイルを
# 直接列挙する方式だった（g0_fix2.shは"files"キーしか見ておらず誤判定）。
# "files"・"include"どちらが使われていてもglobを含まない場合は
# 新規.ts/.tsxを自動検出して追記する。
# ============================================================
node << 'NODEEOF'
const fs = require('fs');
const path = require('path');

const tsconfigPath = path.join('apps/web', 'tsconfig.json');
const raw = fs.readFileSync(tsconfigPath, 'utf8');
const config = JSON.parse(raw);

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

function patchLiteralArray(key) {
  if (!Array.isArray(config[key])) {
    return false;
  }
  const hasGlob = config[key].some((entry) => typeof entry === 'string' && entry.includes('*'));
  if (hasGlob) {
    console.log(`apps/web/tsconfig.json の "${key}" はglobパターンを含むため変更不要。`);
    return false;
  }
  const existing = new Set(config[key]);
  let added = 0;
  for (const rel of relativeToApp) {
    if (!existing.has(rel)) {
      config[key].push(rel);
      existing.add(rel);
      added += 1;
    }
  }
  config[key].sort();
  console.log(`apps/web/tsconfig.json の "${key}" に ${added} 件追加しました。`);
  return added > 0;
}

let changed = false;
changed = patchLiteralArray('files') || changed;
changed = patchLiteralArray('include') || changed;

if (!changed) {
  console.log('変更対象が見つかりませんでした（"files"/"include"ともにglobまたは未定義）。想定外のため tsconfig.json の内容確認が必要。');
}

fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
NODEEOF

echo "=== apps/web: tsc --noEmit ==="
(cd apps/web && npx tsc --noEmit)

echo "=== apps/web: vitest run ==="
(cd apps/web && npx vitest run)
