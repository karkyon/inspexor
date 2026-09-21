#!/usr/bin/env bash
# ===== このファイルをまず編集してから、他のスクリプトを 00→07 の順に実行する =====
# 使い方: 各スクリプトの先頭で `source scripts/gcp/00_env.sh` している。
set -euo pipefail

# --- 必須: 自分の環境に合わせて書き換える ---
export PROJECT_ID="inspexor-mvp-$(whoami | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')-$(date +%y%m%d)"  # 例: inspexor-mvp-taro-260921（グローバル一意である必要あり）
export BILLING_ACCOUNT_ID=""     # `gcloud billing accounts list` で確認して設定
export REGION="asia-northeast1"  # インフラ・運用設計書 v5.1 準拠（東京）
export DB_INSTANCE="inspexor-db-dev"
export DB_NAME="inspexor_dev"
export DB_USER="inspexor"
export DB_PASSWORD="$(openssl rand -base64 24)"   # 初回生成時に控えておく。再実行時は固定値に置き換えること
export AUTH_SECRET="$(openssl rand -base64 32)"
export AR_REPO="inspexor"
export SA_WEB="inspexor-web-sa"
export SA_WORKER="inspexor-worker-sa"
export BUCKET_NAME="${PROJECT_ID}-inspexor-storage"

echo "PROJECT_ID=${PROJECT_ID}"
echo "REGION=${REGION}"
