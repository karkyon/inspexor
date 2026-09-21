#!/usr/bin/env bash
# Cloud Storageバケット、Secret Manager、IAM最小権限サービスアカウントを作成
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh
CONNECTION_NAME="$(cat .gcp-sql-connection-name)"

# public公開防止（インフラ設計書「public bucket禁止」準拠）
gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --location="${REGION}" \
  --uniform-bucket-level-access \
  --public-access-prevention

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost/${DB_NAME}?host=/cloudsql/${CONNECTION_NAME}"

printf '%s' "${DATABASE_URL}" | gcloud secrets create inspexor-database-url --data-file=- 2>/dev/null \
  || printf '%s' "${DATABASE_URL}" | gcloud secrets versions add inspexor-database-url --data-file=-

printf '%s' "${AUTH_SECRET}" | gcloud secrets create inspexor-auth-secret --data-file=- 2>/dev/null \
  || printf '%s' "${AUTH_SECRET}" | gcloud secrets versions add inspexor-auth-secret --data-file=-

# web/worker サービスアカウントを分離（開発スタック定義書「service accountはweb/worker分離」準拠）
gcloud iam service-accounts create "${SA_WEB}" --display-name="INSPEXOR web (Cloud Run)" 2>/dev/null || true
gcloud iam service-accounts create "${SA_WORKER}" --display-name="INSPEXOR worker (Cloud Run)" 2>/dev/null || true

for SA in "${SA_WEB}" "${SA_WORKER}"; do
  SA_EMAIL="${SA}@${PROJECT_ID}.iam.gserviceaccount.com"
  gcloud secrets add-iam-policy-binding inspexor-database-url \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
  gcloud secrets add-iam-policy-binding inspexor-auth-secret \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/cloudsql.client" --condition=None
done

gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_WORKER}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin" --condition=None

echo "03: Storage/Secret/IAM 完了"
