#!/usr/bin/env bash
set -euo pipefail
cd ~/inspexor

# ============================================================
# apps/web/package.json に "type": "module" があるため、
# next.config.js はESMとして解釈される。しかしファイル内は
# CommonJSの `module.exports = nextConfig;` のままで
# ReferenceError: module is not defined になっていた。
# これは私が作った変更ではなく元のscaffoldの設定不整合。
# 該当行のみをESM形式に書き換える（他の内容は変更しない）。
# ============================================================
grep -n "^module.exports = nextConfig;$" apps/web/next.config.js || {
  echo "想定していた行が見つかりませんでした。apps/web/next.config.js の内容を貼ってください。"
  exit 1
}
sed -i 's/^module\.exports = nextConfig;$/export default nextConfig;/' apps/web/next.config.js
echo "=== 修正後のnext.config.js ==="
cat apps/web/next.config.js
