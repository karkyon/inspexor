#!/usr/bin/env bash
# CHG-006: Firestore（Native mode、東京）の作成と、索引・TTL・Security Rules の反映。何度実行してもよい。
#   使い方: bash scripts/firestore/apply-firestore-config.sh <PROJECT_ID>
set -euo pipefail
P="${1:?PROJECT_ID を指定してください}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCATION="asia-northeast1"

echo "--- API 有効化（firestore / firebaserules）"
gcloud services enable firestore.googleapis.com firebaserules.googleapis.com --project="$P" --quiet

echo "--- データベース (default)"
if gcloud firestore databases describe --database='(default)' --project="$P" --format='value(type)' > /tmp/ix-fs-db.txt 2>/dev/null; then
  echo "既存: type=$(cat /tmp/ix-fs-db.txt)"
  grep -q FIRESTORE_NATIVE /tmp/ix-fs-db.txt || { echo "既存のデータベースが Native mode ではありません。中止します。"; exit 1; }
else
  gcloud firestore databases create --database='(default)' --location="$LOCATION" --type=firestore-native --project="$P" --quiet
fi

echo "--- 複合索引（infra/firestore/firestore.indexes.json）"
node -e '
const j = require(process.argv[1]);
for (const ix of j.indexes ?? []) {
  const f = ix.fields.map((x) => x.arrayConfig ? `--field-config=field-path=${x.fieldPath},array-config=contains` : `--field-config=field-path=${x.fieldPath},order=${x.order === "DESCENDING" ? "descending" : "ascending"}`);
  console.log([`--collection-group=${ix.collectionGroup}`, `--query-scope=${(ix.queryScope ?? "COLLECTION").toLowerCase().replace("_", "-")}`, ...f].join(" "));
}' "$ROOT/infra/firestore/firestore.indexes.json" > /tmp/ix-fs-indexes.txt
created=0; existed=0
while IFS= read -r args; do
  [ -z "$args" ] && continue
  # 作成直後のプロジェクト・データベースでは権限の反映待ちで PERMISSION_DENIED 等になることがあるため、20 秒おきに最大 15 回まで再試行（g25b）
  for try in $(seq 1 15); do
    # shellcheck disable=SC2086
    if out=$(gcloud firestore indexes composite create $args --database='(default)' --project="$P" --async --quiet 2>&1); then
      created=$((created+1)); break
    elif echo "$out" | grep -qi "already exists"; then
      existed=$((existed+1)); break
    elif echo "$out" | grep -qiE "PERMISSION_DENIED|FAILED_PRECONDITION|NOT_FOUND|UNAVAILABLE" && [ "$try" -lt 15 ]; then
      [ "$try" = 1 ] && echo "索引: 権限・データベースの反映待ち（最大5分）"
      sleep 20
    else
      echo "索引の作成に失敗: $args"; echo "$out" | tail -3; exit 1
    fi
  done
done < /tmp/ix-fs-indexes.txt
echo "索引: 新規 $created 件 / 既存 $existed 件（新規は作成完了まで数分かかります）"

echo "--- TTL"
node -e '
const j = require(process.argv[1]);
for (const o of j.fieldOverrides ?? []) if (o.ttl) console.log(`${o.collectionGroup} ${o.fieldPath}`);' "$ROOT/infra/firestore/firestore.indexes.json" > /tmp/ix-fs-ttl.txt
while read -r group field; do
  [ -z "$group" ] && continue
  state=$(gcloud firestore fields ttls list --collection-group="$group" --database='(default)' --project="$P" --format='value(ttlConfig.state)' 2>/dev/null | head -1 || true)
  if [ "$state" = "ACTIVE" ] || [ "$state" = "CREATING" ]; then
    echo "TTL $group.$field: $state"
  else
    gcloud firestore fields ttls update "$field" --collection-group="$group" --enable-ttl --database='(default)' --project="$P" --async --quiet > /dev/null
    echo "TTL $group.$field: 設定を開始"
  fi
done < /tmp/ix-fs-ttl.txt

echo "--- Security Rules（クライアントからの直接アクセスを全面禁止）"
TOKEN="$(gcloud auth print-access-token)"
API="https://firebaserules.googleapis.com/v1/projects/$P"
body=$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({source:{files:[{name:"firestore.rules",content:fs.readFileSync(process.argv[1],"utf8")}]}}))' "$ROOT/infra/firestore/firestore.rules")
ruleset=$(curl -sS -X POST "$API/rulesets" -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $P" -H 'content-type: application/json' -d "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.name){console.error(JSON.stringify(j.error??j));process.exit(1)}console.log(j.name)})')
rel="projects/$P/releases/cloud.firestore"
code=$(curl -sS -o /tmp/ix-fs-rel.json -w '%{http_code}' -X PATCH "$API/releases/cloud.firestore" -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $P" -H 'content-type: application/json' \
  -d "{\"release\":{\"name\":\"$rel\",\"rulesetName\":\"$ruleset\"}}")
if [ "$code" = "404" ]; then
  code=$(curl -sS -o /tmp/ix-fs-rel.json -w '%{http_code}' -X POST "$API/releases" -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $P" -H 'content-type: application/json' \
    -d "{\"name\":\"$rel\",\"rulesetName\":\"$ruleset\"}")
fi
[ "$code" = "200" ] || { echo "Security Rules の反映に失敗（HTTP $code）:"; head -c 400 /tmp/ix-fs-rel.json; echo; exit 1; }
echo "Security Rules: 反映済み（$ruleset）"
