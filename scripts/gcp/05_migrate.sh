#!/usr/bin/env bash
# Cloud SQL Auth Proxyをローカルで一時起動し、Cloud SQLへPrisma migrateを実行する。
# 前提: Cloud SQL Auth Proxy (https://cloud.google.com/sql/docs/postgres/sql-proxy) を
#       ローカルにインストール済みであること。現時点ではschema.prismaにモデルが無いため
#       (G0-MIGRATIONで追加予定)、ここでは接続確認 (prisma db execute) のみ行う。
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh
CONNECTION_NAME="$(cat .gcp-sql-connection-name)"

command -v cloud-sql-proxy >/dev/null 2>&1 || {
  echo "cloud-sql-proxy が見つかりません。 https://cloud.google.com/sql/docs/postgres/sql-proxy からインストールしてください。"
  exit 1
}

cloud-sql-proxy "${CONNECTION_NAME}" --port 5433 &
PROXY_PID=$!
trap "kill ${PROXY_PID}" EXIT
sleep 3

export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5433/${DB_NAME}"

pnpm --filter @inspexor/db prisma:generate
echo "SELECT 1;" | pnpm --filter @inspexor/db exec prisma db execute --stdin --schema packages/db/prisma/schema.prisma

echo "05: DB接続確認 完了（モデル未定義のためmigrate deployはG0-MIGRATION実装後に実行する）"
