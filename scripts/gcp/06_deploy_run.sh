#!/usr/bin/env bash
# Cloud Run へ web / worker をデプロイ（インフラ設計書 production節のスペックに準拠）
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh
source .gcp-images
CONNECTION_NAME="$(cat .gcp-sql-connection-name)"

gcloud run deploy inspexor-web \
  --image="${WEB_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${SA_WEB}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=inspexor-database-url:latest,AUTH_SECRET=inspexor-auth-secret:latest" \
  --set-env-vars="APP_ENV=dev,LOG_LEVEL=info,TZ=UTC,BUSINESS_TIMEZONE=Asia/Tokyo" \
  --cpu=1 --memory=512Mi --concurrency=40 --timeout=60 --min-instances=1 --max-instances=5 \
  --allow-unauthenticated

gcloud run deploy inspexor-worker \
  --image="${WORKER_IMAGE}" \
  --region="${REGION}" \
  --platform=managed \
  --service-account="${SA_WORKER}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --add-cloudsql-instances="${CONNECTION_NAME}" \
  --set-secrets="DATABASE_URL=inspexor-database-url:latest" \
  --set-env-vars="APP_ENV=dev,LOG_LEVEL=info,STORAGE_BUCKET=${BUCKET_NAME}" \
  --cpu=1 --memory=512Mi --concurrency=10 --timeout=300 --min-instances=0 --max-instances=3 \
  --no-allow-unauthenticated

WEB_URL="$(gcloud run services describe inspexor-web --region="${REGION}" --format='value(status.url)')"
echo "WEB_URL=${WEB_URL}"
echo "${WEB_URL}" > .gcp-web-url
echo "06: Cloud Runデプロイ 完了"
