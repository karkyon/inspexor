#!/usr/bin/env bash
# Artifact Registry作成 + web/worker イメージを Cloud Build でビルド&push
# （ローカルDockerを使わず GCP上でビルドするため、Docker未インストールの端末でも実行できる）
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh

gcloud artifacts repositories create "${AR_REPO}" \
  --repository-format=docker \
  --location="${REGION}" 2>/dev/null || echo "Artifact Registry repo は既に存在する可能性があります（続行）"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

WEB_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/web:latest"
WORKER_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/worker:latest"

gcloud builds submit . --config=- <<CFG
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "apps/web/Dockerfile", "-t", "${WEB_IMAGE}", "."]
images: ["${WEB_IMAGE}"]
CFG

gcloud builds submit . --config=- <<CFG
steps:
  - name: gcr.io/cloud-builders/docker
    args: ["build", "-f", "apps/worker/Dockerfile", "-t", "${WORKER_IMAGE}", "."]
images: ["${WORKER_IMAGE}"]
CFG

echo "WEB_IMAGE=${WEB_IMAGE}" > .gcp-images
echo "WORKER_IMAGE=${WORKER_IMAGE}" >> .gcp-images
echo "04: ビルド&push 完了"
