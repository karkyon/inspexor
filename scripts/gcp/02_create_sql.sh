#!/usr/bin/env bash
# Cloud SQL (PostgreSQL16) を最小費用構成で作成する
# db-f1-micro: 共有コア最小tier。ローンチ確認後は不要ならば削除/停止すること（99_teardown.sh参照）。
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh

gcloud sql instances create "${DB_INSTANCE}" \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region="${REGION}" \
  --storage-size=10GB \
  --storage-type=SSD \
  --no-backup \
  --availability-type=ZONAL

gcloud sql databases create "${DB_NAME}" --instance="${DB_INSTANCE}"

gcloud sql users create "${DB_USER}" \
  --instance="${DB_INSTANCE}" \
  --password="${DB_PASSWORD}"

CONNECTION_NAME="$(gcloud sql instances describe "${DB_INSTANCE}" --format='value(connectionName)')"
echo "CONNECTION_NAME=${CONNECTION_NAME}"
echo "${CONNECTION_NAME}" > .gcp-sql-connection-name

echo "02: Cloud SQL作成 完了（--no-backup は費用最小化のための開発用設定。本番はインフラ設計書の daily backup / PITR7d に従うこと）"
