#!/usr/bin/env bash
# INSPEXOR 本番の構築・更新（CHG-006 g25）。何度実行してもよい（作成済みのものはそのまま使う）。
#   使い方: bash scripts/gcp/deploy-prod.sh
#   環境変数（任意）: PROD_PROJECT（既定 inspexor-jadeworks-prod）/ DEV_PROJECT（課金アカウントの参照元、既定 inspexor-jadeworks-dev）
#                     WORKER_SCHEDULE（worker の定期起動。既定 */15 * * * *。CHG-016）
#                     BILLING_ACCOUNT（例 0123AB-4567CD-89EF01。未指定なら DEV_PROJECT と同じ課金アカウント）
#
# 構成（提案書 P.12・CHG-006 §4。すべて東京 asia-northeast1）
#   Cloud Run  inspexor-web（公開・0台から起動）/ inspexor-worker（IAM 認証・0台から起動・同時1件）
#   Firestore  (default) Native。索引・TTL・Security Rules（全拒否）・削除保護
#   Cloud Storage  <PROJECT>-documents（帳票 PDF。公開禁止）/ <PROJECT>-backups（Firestore 日次書き出し。30日で削除）
#   Cloud Scheduler  worker を15分ごとに起動（取りこぼしの保険。通常は web が確定直後に起動）/ Firestore を毎日 03:15 に書き出し
#                    一時停止中の job は、作り直した後も一時停止のまま（CHG-016。再開は gcloud scheduler jobs resume）
#   Secret Manager  AUTH_SECRET（本番用に新規生成。値は表示しない）
#   予算アラート  月 ¥2,000（50%・90%・100% で通知）
#   Cloud Run Job  inspexor-diag（worker image で Firestore・Cloud Storage・Chromium の所要時間を測る。業務データは作らない）
set -euo pipefail
P="${PROD_PROJECT:-inspexor-jadeworks-prod}"
DEV="${DEV_PROJECT:-inspexor-jadeworks-dev}"
R=asia-northeast1
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC_BUCKET="$P-documents"
BAK_BUCKET="$P-backups"
AR_REPO=inspexor
WEB_SA="inspexor-web@$P.iam.gserviceaccount.com"
WORKER_SA="inspexor-worker@$P.iam.gserviceaccount.com"
SCHED_SA="inspexor-scheduler@$P.iam.gserviceaccount.com"
BUILD_SA="inspexor-build@$P.iam.gserviceaccount.com"
SECRET=inspexor-auth-secret
WORKER_SCHEDULE="${WORKER_SCHEDULE:-*/15 * * * *}"
TAG="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
IMG="$R-docker.pkg.dev/$P/$AR_REPO"
WEB_IMAGE="$IMG/web:$TAG"
WORKER_IMAGE="$IMG/worker:$TAG"
export CLOUDSDK_CORE_DISABLE_PROMPTS=1
q() { "$@" > /dev/null 2>&1; }

echo "=== [1/10] プロジェクト $P"
if ! q gcloud projects describe "$P"; then
  gcloud projects create "$P" --name="INSPEXOR prod" 2>&1 | tail -2
fi
if [ "$(gcloud billing projects describe "$P" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]; then
  BA="${BILLING_ACCOUNT:-$(gcloud billing projects describe "$DEV" --format='value(billingAccountName)' | sed 's#billingAccounts/##')}"
  [ -n "$BA" ] || { echo "課金アカウントが分かりません（BILLING_ACCOUNT を指定してください）。中止します。"; exit 1; }
  gcloud billing projects link "$P" --billing-account="$BA" > /dev/null
  echo "課金アカウントを紐付けました"
fi
BA="$(gcloud billing projects describe "$P" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"
echo "課金: 有効"

echo "=== [2/10] API 有効化（数分かかることがあります）"
gcloud services enable --project="$P" \
  run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com firestore.googleapis.com firebaserules.googleapis.com storage.googleapis.com \
  iam.googleapis.com iamcredentials.googleapis.com logging.googleapis.com billingbudgets.googleapis.com
PNUM="$(gcloud projects describe "$P" --format='value(projectNumber)')"

echo "=== [3/10] Firestore（索引・TTL・Security Rules・削除保護）"
bash "$ROOT/scripts/firestore/apply-firestore-config.sh" "$P"
gcloud firestore databases update --database='(default)' --delete-protection --project="$P" > /dev/null 2>&1 && echo "削除保護: 有効" || echo "※ 削除保護を設定できませんでした（続行）"

echo "=== [4/10] Cloud Storage"
for b in "$DOC_BUCKET" "$BAK_BUCKET"; do
  if ! q gcloud storage buckets describe "gs://$b" --project="$P"; then
    gcloud storage buckets create "gs://$b" --project="$P" --location="$R" --uniform-bucket-level-access --public-access-prevention > /dev/null
    echo "作成: gs://$b"
  else
    echo "既存: gs://$b"
  fi
done
cat > /tmp/ix-lifecycle.json << 'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}
JSON
gcloud storage buckets update "gs://$BAK_BUCKET" --lifecycle-file=/tmp/ix-lifecycle.json --project="$P" > /dev/null
echo "gs://$BAK_BUCKET: 30日で削除"

echo "=== [5/10] サービスアカウントと権限（最小権限）"
for n in inspexor-web inspexor-worker inspexor-scheduler inspexor-build; do
  q gcloud iam service-accounts describe "$n@$P.iam.gserviceaccount.com" --project="$P" || \
    gcloud iam service-accounts create "$n" --project="$P" --display-name="$n" > /dev/null
done
sleep 5
# 作成直後のサービスアカウントは反映に時間がかかることがあるため、失敗したら 15 秒おきに4回まで再試行
retry() { local i; for i in 1 2 3 4; do "$@" > /tmp/ix-iam.err 2>&1 && return 0; sleep 15; done; echo "権限の設定に失敗: $*"; tail -3 /tmp/ix-iam.err; return 1; }
pbind() { retry gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$1" --role="$2" --condition=None; }
bbind() { retry gcloud storage buckets add-iam-policy-binding "gs://$1" --member="serviceAccount:$2" --role="$3" --project="$P"; }
pbind "$WEB_SA" roles/datastore.user
pbind "$WORKER_SA" roles/datastore.user
pbind "$SCHED_SA" roles/datastore.importExportAdmin
pbind "$BUILD_SA" roles/artifactregistry.writer
pbind "$BUILD_SA" roles/logging.logWriter
pbind "$BUILD_SA" roles/storage.objectViewer
bbind "$DOC_BUCKET" "$WEB_SA" roles/storage.objectViewer
bbind "$DOC_BUCKET" "$WORKER_SA" roles/storage.objectUser
# Firestore の書き出しは Firestore のサービスエージェントがバケットに書く
gcloud beta services identity create --service=firestore.googleapis.com --project="$P" > /dev/null 2>&1 || true
bbind "$BAK_BUCKET" "service-$PNUM@gcp-sa-firestore.iam.gserviceaccount.com" roles/storage.objectAdmin
echo "web: Firestore 読み書き・帳票の読出し / worker: Firestore 読み書き・帳票の保存 / scheduler: worker 起動・Firestore 書き出し / build: image の保存"

echo "=== [6/10] Secret Manager（AUTH_SECRET。値は表示しない）"
if ! q gcloud secrets describe "$SECRET" --project="$P"; then
  gcloud secrets create "$SECRET" --project="$P" --replication-policy=user-managed --locations="$R" > /dev/null
fi
if [ -z "$(gcloud secrets versions list "$SECRET" --project="$P" --filter='state=ENABLED' --format='value(name)' --limit=1)" ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))' | gcloud secrets versions add "$SECRET" --project="$P" --data-file=- > /dev/null
  echo "新しい AUTH_SECRET を作成しました（開発用とは別の値）"
else
  echo "既存の AUTH_SECRET を使います"
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project="$P" --member="serviceAccount:$WEB_SA" --role=roles/secretmanager.secretAccessor > /dev/null

echo "=== [7/10] container image（Cloud Build。初回は10〜20分）"
if ! q gcloud artifacts repositories describe "$AR_REPO" --location="$R" --project="$P"; then
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location="$R" --project="$P" > /dev/null
fi
cat > /tmp/ix-ar-cleanup.json << 'JSON'
[{"name":"keep-recent","action":{"type":"Keep"},"mostRecentVersions":{"keepCount":3}},
 {"name":"delete-old","action":{"type":"Delete"},"condition":{"olderThan":"2592000s"}}]
JSON
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" --location="$R" --project="$P" --policy=/tmp/ix-ar-cleanup.json --no-dry-run > /dev/null 2>&1 || echo "※ image の自動削除設定に失敗（続行）"
if q gcloud artifacts docker images describe "$WEB_IMAGE" --project="$P" && q gcloud artifacts docker images describe "$WORKER_IMAGE" --project="$P"; then
  echo "image は作成済み（$TAG）"
else
  [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { echo "commit していない変更があります。commit してから実行してください。"; exit 1; }
  set +e
  (cd "$ROOT" && gcloud builds submit --project="$P" --region="$R" \
    --config=infra/cloudbuild/cloudbuild.yaml \
    --substitutions="_WEB_IMAGE=$WEB_IMAGE,_WORKER_IMAGE=$WORKER_IMAGE" \
    --service-account="projects/$P/serviceAccounts/$BUILD_SA" \
    --default-buckets-behavior=regional-user-owned-bucket . > /tmp/ix-build.log 2>&1)
  brc=$?
  set -e
  if [ "$brc" != 0 ]; then
    echo "image の作成に失敗しました。ログの末尾:"; grep -vE '^\s*$' /tmp/ix-build.log | tail -40; exit 1
  fi
  echo "image 作成: $TAG"
fi

echo "=== [8/10] Cloud Run（worker → web）"
COMMON_ENV="FIRESTORE_PROJECT_ID=$P,STORAGE_BUCKET=$DOC_BUCKET,DAILY_MAIL_ENABLED=false,APP_ENV=prod"
gcloud run deploy inspexor-worker --project="$P" --region="$R" --image="$WORKER_IMAGE" \
  --service-account="$WORKER_SA" --no-allow-unauthenticated \
  --min-instances=0 --max-instances=1 --concurrency=1 --cpu=1 --memory=1Gi --timeout=300 --cpu-boost \
  --set-env-vars="$COMMON_ENV,WORKER_BUDGET_MS=240000" --quiet > /tmp/ix-run.log 2>&1 || { echo "worker の配置に失敗しました:"; tail -15 /tmp/ix-run.log; exit 1; }
WORKER_URL="$(gcloud run services describe inspexor-worker --project="$P" --region="$R" --format='value(status.url)')"
[ -n "$WORKER_URL" ] || { echo "worker の起動に失敗しました。中止します。"; exit 1; }
for sa in "$WEB_SA" "$SCHED_SA"; do
  gcloud run services add-iam-policy-binding inspexor-worker --project="$P" --region="$R" --member="serviceAccount:$sa" --role=roles/run.invoker > /dev/null
done
gcloud run deploy inspexor-web --project="$P" --region="$R" --image="$WEB_IMAGE" \
  --service-account="$WEB_SA" --allow-unauthenticated \
  --min-instances=0 --max-instances=2 --concurrency=40 --cpu=1 --memory=512Mi --timeout=60 --cpu-boost \
  --set-env-vars="$COMMON_ENV,WORKER_URL=$WORKER_URL" --set-secrets="AUTH_SECRET=$SECRET:latest" --quiet > /tmp/ix-run.log 2>&1 || { echo "web の配置に失敗しました:"; tail -15 /tmp/ix-run.log; exit 1; }
WEB_URL="$(gcloud run services describe inspexor-web --project="$P" --region="$R" --format='value(status.url)')"
[ -n "$WEB_URL" ] || { echo "web の起動に失敗しました。中止します。"; exit 1; }
echo "$WEB_URL" > "$ROOT/.gcp-prod-web-url"
echo "web: $WEB_URL"
echo "worker: $WORKER_URL（IAM 認証）"

echo "=== [9/10] Cloud Scheduler"
sched() {
  local name="$1"; shift
  local state
  # 設定を確実に揃えるため、既存なら作り直す（job の履歴以外に失うものは無い）。
  # CHG-016: 一時停止中（利用開始前などで費用を止めている）なら、作り直した後も一時停止に戻す
  state="$(gcloud scheduler jobs describe "$name" --location="$R" --project="$P" --format='value(state)' 2>/dev/null || true)"
  [ -n "$state" ] && gcloud scheduler jobs delete "$name" --location="$R" --project="$P" --quiet > /dev/null
  gcloud scheduler jobs create http "$name" --location="$R" --project="$P" "$@" > /dev/null
  if [ "$state" = "PAUSED" ]; then
    gcloud scheduler jobs pause "$name" --location="$R" --project="$P" > /dev/null
    echo "$name: 設定済み（一時停止のまま。再開: gcloud scheduler jobs resume $name --location=$R --project=$P）"
  else
    echo "$name: 設定済み"
  fi
}
sched inspexor-worker-run --schedule="$WORKER_SCHEDULE" --time-zone=Asia/Tokyo --uri="$WORKER_URL/run" --http-method=POST \
  --oidc-service-account-email="$SCHED_SA" --oidc-token-audience="$WORKER_URL" --attempt-deadline=320s
sched inspexor-firestore-export --schedule="15 3 * * *" --time-zone=Asia/Tokyo \
  --uri="https://firestore.googleapis.com/v1/projects/$P/databases/(default):exportDocuments" --http-method=POST \
  --headers=Content-Type=application/json --message-body="{\"outputUriPrefix\":\"gs://$BAK_BUCKET\"}" \
  --oauth-service-account-email="$SCHED_SA" --oauth-token-scope=https://www.googleapis.com/auth/datastore

echo "=== [10/10] 予算アラート（月 ¥2,000）"
CUR="$(gcloud billing accounts describe "$BA" --format='value(currencyCode)' 2>/dev/null || true)"
if [ "$CUR" = "JPY" ]; then AMOUNT=2000JPY; else AMOUNT=14USD; fi
if gcloud billing budgets list --billing-account="$BA" --billing-project="$P" --format='value(displayName)' 2>/dev/null | grep -qx "INSPEXOR 本番"; then
  echo "既存（INSPEXOR 本番）"
elif gcloud billing budgets create --billing-account="$BA" --billing-project="$P" --display-name="INSPEXOR 本番" \
  --budget-amount="$AMOUNT" --filter-projects="projects/$P" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 > /dev/null 2>/tmp/ix-budget.err; then
  echo "作成: $AMOUNT（課金アカウントの通貨 ${CUR:-不明}）。通知先は課金アカウントの管理者のメール"
else
  echo "※ 予算アラートを作成できませんでした（課金アカウントの管理者権限が必要）。Cloud Console の「お支払い → 予算とアラート」で設定してください:"
  tail -2 /tmp/ix-budget.err
fi

echo "=== 構築完了（$P / image $TAG）"
