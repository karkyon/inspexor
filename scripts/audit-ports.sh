#!/usr/bin/env bash
# 開発着手前に実行し、既存のport/コンテナ使用状況を確認したうえで
# .env.local の DB_HOST_PORT / WORKER_URL 等を決定する。
# 本ファイル自体はportを決め打ちしない（インフラ・運用設計書「local port」節準拠）。
set -euo pipefail

echo "== 使用中のTCPポート (LISTEN) =="
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null || ss -ltn
elif command -v lsof >/dev/null 2>&1; then
  lsof -iTCP -sTCP:LISTEN -n -P
else
  echo "ss / lsof が見つかりません。手動で確認してください。"
fi

echo
echo "== 既存のDocker Compose project一覧 =="
if command -v docker >/dev/null 2>&1; then
  docker compose ls 2>/dev/null || echo "docker compose ls が実行できません"
  echo
  echo "== 既存のDocker volume (inspexor関連) =="
  docker volume ls --format '{{.Name}}' | grep -i inspexor || echo "なし"
else
  echo "docker コマンドが見つかりません。"
fi

echo
echo "上記を踏まえ、空いているホストportを .env.local の DB_HOST_PORT / WORKER_URL に設定してください。"
