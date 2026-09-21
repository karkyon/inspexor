#!/usr/bin/env bash
# 実際にCloud Run上のURLへHTTPリクエストを送り、アプリ起動とDB疎通を確認する
set -euo pipefail
cd "$(dirname "$0")/../.."
WEB_URL="$(cat .gcp-web-url)"

echo "== トップページ =="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" "${WEB_URL}/"

echo "== DB疎通確認 (/api/health) =="
curl -sS "${WEB_URL}/api/health" | tee /tmp/inspexor-health.json
echo
if grep -q '"db":"ok"' /tmp/inspexor-health.json; then
  echo "OK: Cloud SQLへの実接続を確認しました"
else
  echo "NG: DB接続に失敗しています。上記レスポンスのerrorを確認してください。"
  exit 1
fi
