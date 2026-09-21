#!/usr/bin/env bash
# GCPプロジェクト作成・課金紐付け・必要APIの有効化
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/gcp/00_env.sh

gcloud projects create "${PROJECT_ID}" --name="INSPEXOR MVP" || echo "プロジェクトは既に存在する可能性があります（続行）"

if [ -z "${BILLING_ACCOUNT_ID}" ]; then
  echo "BILLING_ACCOUNT_ID が未設定です。'gcloud billing accounts list' で確認し 00_env.sh に設定してください。"
  exit 1
fi
gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT_ID}"

gcloud config set project "${PROJECT_ID}"

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  storage.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com

echo "01: API有効化 完了"
