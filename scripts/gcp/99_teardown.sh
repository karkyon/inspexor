#!/usr/bin/env bash
# 費用発生を止めるため、確認が終わったらこれを実行して全リソースを削除する。
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh

gcloud run services delete inspexor-web --region="${REGION}" --quiet || true
gcloud run services delete inspexor-worker --region="${REGION}" --quiet || true
gcloud sql instances delete "${DB_INSTANCE}" --quiet || true
gcloud storage rm -r "gs://${BUCKET_NAME}" --quiet || true
gcloud artifacts repositories delete "${AR_REPO}" --location="${REGION}" --quiet || true
gcloud secrets delete inspexor-database-url --quiet || true
gcloud secrets delete inspexor-auth-secret --quiet || true

echo "99: 削除完了。プロジェクトごと課金停止したい場合は次を実行:"
echo "  gcloud projects delete ${PROJECT_ID}"
