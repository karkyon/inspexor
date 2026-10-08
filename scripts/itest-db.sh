#!/usr/bin/env bash
# 統合テスト用 PostgreSQL 16 を docker で起動し、管理DBの接続URLを標準出力に出す。
set -euo pipefail
NAME=inspexor-pg-itest
PORT=5433
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD=test -p "$PORT:5432" postgres:16 >/dev/null
fi
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    echo "postgresql://postgres:test@127.0.0.1:$PORT/postgres"
    exit 0
  fi
  sleep 1
done
echo "PostgreSQL が起動しませんでした" >&2
exit 1
