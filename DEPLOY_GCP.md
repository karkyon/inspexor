# INSPEXOR 本番の構築・更新手順（CHG-006 g25）

旧版（Cloud SQL を使う雛形の確認手順と `scripts/gcp/01〜07, 99`）は CHG-006（Firestore 移行）で廃止した。

## 構成（提案書 P.12。すべて東京 asia-northeast1）

| 役割 | サービス | 設定 |
|---|---|---|
| 画面・API | Cloud Run `inspexor-web` | 公開、0〜2台、512MiB。`AUTH_SECRET` は Secret Manager |
| 帳票作成・配送 | Cloud Run `inspexor-worker` | IAM 認証、0〜1台、同時1件、1GiB。`POST /run` で仕事が無くなるまで処理 |
| データ | Firestore (default) | Native、索引・TTL・Security Rules（全拒否）、削除保護 |
| 帳票 PDF | Cloud Storage `<PROJECT>-documents` | 公開禁止・均一アクセス。web は署名付き URL の検証後に読み出して返す |
| バックアップ | Cloud Scheduler → Firestore 書き出し | 毎日 03:15、`<PROJECT>-backups`、30日で削除 |
| worker の起動 | web（確定・帳票操作の直後）＋ Cloud Scheduler（1分ごと） | どちらも ID token で認証 |
| 費用の監視 | 予算アラート | 月 ¥2,000（50%・90%・100%） |

サービスアカウントは役割ごとに分ける（web / worker / scheduler / build）。開発用プロジェクト `inspexor-jadeworks-dev` とは別プロジェクト `inspexor-jadeworks-prod`。

## 構築・更新

Cloud Shell で、commit 済みの main から実行する（何度実行してもよい。image は commit ごとに作る）。

```bash
cd ~/inspexor
bash scripts/gcp/deploy-prod.sh        # 構築・更新
bash scripts/gcp/diag-prod.sh          # Cloud Run 上での所要時間の計測（業務データは作らない）
```

初期管理者（初回のみ。パスワードは `~/.inspexor-prod-admin-password`、表示しない）:

```bash
cd ~/inspexor/apps/web
GOOGLE_CLOUD_QUOTA_PROJECT=inspexor-jadeworks-prod APP_ENV=prod FIRESTORE_PROJECT_ID=inspexor-jadeworks-prod npx tsx scripts/create-admin.ts
```

開発用の合成データ（`seed-dev-users.ts` / `seed-masters.ts`）は本番に入れない（APP_ENV=local/dev でしか動かない）。

## 確認

- `curl -s $(cat .gcp-prod-web-url)/api/health` → `{"app":"ok","db":"ok",…}`
- worker のログ: `gcloud run services logs read inspexor-worker --project inspexor-jadeworks-prod --region asia-northeast1 --limit 50`
- web のログ: 同 `inspexor-web`
