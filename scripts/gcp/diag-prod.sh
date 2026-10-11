#!/usr/bin/env bash
# 本番の所要時間の計測（CHG-006 g25）。worker と同じ image・権限の Cloud Run Job で実行する（業務データは作らない）。
#   worker-bench : Firestore 読込・transaction（_health/bench）、Cloud Storage 保存・読出し・照合、Chromium PDF化
#   storage-bench: Cloud Storage 読出しの方式比較（旧 SDK download / 新 fetch get・stat）
#   使い方: bash scripts/gcp/diag-prod.sh [worker-bench|storage-bench ...]（既定は両方）
set -euo pipefail
P="${PROD_PROJECT:-inspexor-jadeworks-prod}"
R=asia-northeast1
JOB=inspexor-diag
WORKER_SA="inspexor-worker@$P.iam.gserviceaccount.com"
IMAGE="$(gcloud run services describe inspexor-worker --project="$P" --region="$R" --format='value(spec.template.spec.containers[0].image)')"
[ -n "$IMAGE" ] || { echo "inspexor-worker がありません（先に deploy-prod.sh）。"; exit 1; }
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

gcloud run jobs deploy "$JOB" --project="$P" --region="$R" --image="$IMAGE" --service-account="$WORKER_SA" \
  --cpu=1 --memory=1Gi --task-timeout=900 --max-retries=0 \
  --set-env-vars="FIRESTORE_PROJECT_ID=$P,STORAGE_BUCKET=$P-documents,APP_ENV=prod" \
  --command=node --args=--import,tsx,scripts/worker-bench.ts --quiet > /tmp/ix-diag-deploy.log 2>&1 || { tail -10 /tmp/ix-diag-deploy.log; exit 1; }

for script in "${@:-worker-bench storage-bench}"; do
  for s in $script; do
    echo "--- $s（Cloud Run 上で実行）"
    exe="$(gcloud run jobs execute "$JOB" --project="$P" --region="$R" --args=--import,tsx,"scripts/$s.ts" --wait --format='value(metadata.name)' 2>/tmp/ix-diag-exec.err || true)"
    [ -n "$exe" ] || exe="$(gcloud run jobs executions list --job="$JOB" --project="$P" --region="$R" --limit=1 --format='value(metadata.name)')"
    sleep 20 # ログの反映待ち
    gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\" AND labels.\"run.googleapis.com/execution_name\"=\"$exe\"" \
      --project="$P" --order=asc --limit=200 --format='value(textPayload)' | grep -vE '^\s*$|npm notice' || echo "（ログなし）"
    gcloud run jobs executions describe "$exe" --project="$P" --region="$R" --format='value(status.succeededCount,status.failedCount)' | awk '{print "結果: 成功 " ($1==""?0:$1) " / 失敗 " ($2==""?0:$2)}'
  done
done
