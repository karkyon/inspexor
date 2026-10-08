// apps/web/tsconfig.json 補正:
//  (1) app/lib/components/scripts 配下の .ts/.tsx を "include" にリテラル追記（glob有無に関係なく）
//  (2) 実在しないリテラルパスを "include" から除去（ルート移設で消えたファイル対策）
//  (3) compilerOptions.lib に DOM / DOM.Iterable を追加（extends 連鎖から既存libを継承した上で）
const fs = require('fs');
const path = require('path');

const appDir = process.argv[2] || 'apps/web';
const tsconfigPath = path.join(appDir, 'tsconfig.json');
const config = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));

function stripJsonComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

function readJsonLoose(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1'));
  }
}

function resolveInheritedLib(cfg, baseDir) {
  if (cfg.compilerOptions && Array.isArray(cfg.compilerOptions.lib)) {
    return cfg.compilerOptions.lib;
  }
  if (typeof cfg.extends !== 'string') {
    return null;
  }
  let parentPath = path.resolve(baseDir, cfg.extends);
  if (!parentPath.endsWith('.json')) {
    parentPath += '.json';
  }
  if (!fs.existsSync(parentPath)) {
    console.log(`extends先 ${cfg.extends} が見つかりません（lib継承の解決をスキップ）`);
    return null;
  }
  return resolveInheritedLib(readJsonLoose(parentPath), path.dirname(parentPath));
}

// ---- (1)(2) include ----
function walk(dir, results) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, results);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) results.push(full);
  }
}
const found = [];
for (const base of ['app', 'lib', 'components']) {
  const d = path.join(appDir, base);
  if (fs.existsSync(d)) walk(d, found);
}
const rel = found.map((p) => path.relative(appDir, p).split(path.sep).join('/'));

if (!Array.isArray(config.include)) config.include = [];
const before = config.include.length;
config.include = config.include.filter(
  (e) => typeof e !== 'string' || e.includes('*') || e.endsWith('.d.ts') || !/\.(ts|tsx)$/.test(e) || fs.existsSync(path.join(appDir, e)),
);
const removed = before - config.include.length;
const existing = new Set(config.include);
let added = 0;
for (const r of rel) {
  if (!existing.has(r)) {
    config.include.push(r);
    existing.add(r);
    added += 1;
  }
}
config.include.sort();
console.log(`include: 追加 ${added} 件 / 実在しないパス除去 ${removed} 件`);

// ---- (3) lib ----
const inherited = resolveInheritedLib(config, appDir);
const libs = inherited ? [...inherited] : ['ES2022'];
const lower = new Set(libs.map((l) => String(l).toLowerCase()));
for (const l of ['DOM', 'DOM.Iterable']) {
  if (!lower.has(l.toLowerCase())) libs.push(l);
}
config.compilerOptions = config.compilerOptions || {};
config.compilerOptions.lib = libs;
console.log(`compilerOptions.lib = ${JSON.stringify(libs)}（継承元: ${inherited ? JSON.stringify(inherited) : 'なし→ES2022'}）`);

fs.writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n');
