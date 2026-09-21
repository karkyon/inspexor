# INSPEXOR — GCP最小費用デプロイ手順書（本日稼働確認用）

## 0. 最初に必ず読むこと（正直な前提）

- 私（Claude）はこのサンドボックスからGCPへのネットワークアクセス・認証情報を持っていないため、**この会話の中で実際にクラウドへデプロイすることはできません**。以下はあなたの端末（またはGCP Cloud Shell）で実行してください。
- 現時点のリポジトリは **G0（Gate 0）着手前**の雛形です。`packages/domain` の業務ロジック、`packages/db/prisma/schema.prisma` のテーブル定義、`apps/web` のAPI/画面は未実装です。したがって本手順で確認できるのは、
  - Next.jsアプリ（プレースホルダー画面）がCloud Run上で実際に起動すること
  - そのアプリからCloud SQL（PostgreSQL16）へ実際にネットワーク接続できること（`/api/health` が実クエリ `SELECT 1` を発行して確認）
  であり、**請求計算・日報PDF・メール送信等の業務機能はまだ存在しません**。「インフラが本日中に実際に稼働する」ことの確認手順であり、「業務システムとして完成する」手順ではない点を明確にしておきます。
- 採用クラウドは **GCP** です。本プロジェクトの `INSPEXOR_開発スタック定義書_v5.1.md` / `INSPEXOR_インフラ・運用設計書_v5.1.md` が既にGCP（Cloud Run / Cloud SQL / Artifact Registry / Secret Manager, asia-northeast1）を正本として指定しているため、AWSは採用しません（変更する場合はADRが必要というのがプロジェクトのルールです）。
- コストを最小化するため、本番仕様（private IP＋VPC Connector、daily backup、PITR7日）から一部意図的に外しています。差分は各所に明記しています。**確認が終わったら `99_teardown.sh` で必ず削除してください。**（Cloud SQLは起動しているだけで時間課金されます）

## 1. 事前準備（あなたの端末）

```bash
# 1) unzipして展開
unzip inspexor-scaffold.zip
cd inspexor

# 2) Google Cloud CLIが無ければインストール
#    https://cloud.google.com/sdk/docs/install
gcloud --version

# 3) ログイン
gcloud auth login
gcloud auth application-default login

# 4) 請求先アカウントIDを確認
gcloud billing accounts list
```

`scripts/gcp/00_env.sh` を開き、**`BILLING_ACCOUNT_ID`** を上記で確認した値に必ず設定してください。
`PROJECT_ID` はグローバルで一意な名前が必要です（デフォルトで日付入りの名前を自動生成しますが、既に使われていたら変更してください）。

## 2. 実行手順（この順番で実行する。各stepの成功を確認してから次へ進む）

```bash
chmod +x scripts/gcp/*.sh

# Step 1: プロジェクト作成・課金紐付け・API有効化
bash scripts/gcp/01_setup_project.sh

# Step 2: Cloud SQL (PostgreSQL16, db-f1-micro) 作成 ※数分かかる
bash scripts/gcp/02_create_sql.sh

# Step 3: Cloud Storage / Secret Manager / IAM(web・worker分離) 作成
bash scripts/gcp/03_storage_and_secrets.sh

# Step 4: Artifact Registry作成 + Cloud Buildでweb/workerイメージをビルド&push
#         （ローカルにDockerが無くても実行可能。GCP側でビルドする）
bash scripts/gcp/04_build_push.sh

# Step 5: Cloud Run(web/worker)へデプロイ
bash scripts/gcp/06_deploy_run.sh

# Step 6: 実際に稼働しているかスモークテスト
bash scripts/gcp/07_smoke_test.sh
```

`07_smoke_test.sh` が以下を出力すれば、**Cloud Run上で実際にアプリが起動し、実際にCloud SQLへ接続できています**。
```
== トップページ ==
HTTP 200
== DB疎通確認 (/api/health) ==
{"app":"ok","db":"ok","latencyMs":...}
OK: Cloud SQLへの実接続を確認しました
```

`WEB_URL` は `.gcp-web-url` ファイル、またはコマンド出力に表示されます。ブラウザで開いて実際の画面を確認してください。

### 補足: `05_migrate.sh` について
`packages/db/prisma/schema.prisma` にはまだテーブル定義が無いため（G0-MIGRATIONで追加予定）、本スクリプトは「Cloud SQL Auth Proxy経由でPrismaが接続できるか」の確認のみを行います。`cloud-sql-proxy` の事前インストールが必要です。実テーブルのmigrationはG0-MIGRATION実装後に同じ仕組みで `prisma migrate deploy` を実行します。

## 3. コスト構成と最小化ポイント

| リソース | 設定 | 目安費用 |
|---|---|---|
| Cloud SQL | db-f1-micro, 10GB SSD, ZONAL, backup無効 | 起動時間課金（約1ヶ月あたり¥1,500〜2,000。数時間の確認だけなら数十円） |
| Cloud Run (web) | 1vCPU/512MiB, min-instances=1 | 常時1インスタンスのため多少課金される。確認後は`min-instances=0`に変更するかteardown推奨 |
| Cloud Run (worker) | 1vCPU/512MiB, min-instances=0 | リクエストが無ければほぼ無課金 |
| Artifact Registry | イメージ2つ | 数百MB、ほぼ無視できる費用 |
| Cloud Storage | バケット1つ、空 | ほぼ無視できる費用 |

**確認が終わったら必ず実行:**
```bash
bash scripts/gcp/99_teardown.sh
# 完全に課金を止めたい場合はプロジェクトごと削除
gcloud projects delete <PROJECT_ID>
```

## 4. 本番仕様との既知の差分（ADR化が必要）

| 項目 | 今回（最小費用/即日確認用） | インフラ設計書の本番仕様 | 対応 |
|---|---|---|---|
| Cloud SQL接続 | Cloud SQL Auth Proxy（`--add-cloudsql-instances`）、パブリックIP経由 | private IP + VPC Serverless Connector | 本番移行時にVPC Connectorを追加しADR化 |
| Backup | 無効（`--no-backup`） | daily backup + PITR7日 | 本番移行時に有効化 |
| Cloud Run web min-instances | 1（確認しやすくするため） | インフラ設計書通り1 | 差分なし |
| 認証 | 未実装（`--allow-unauthenticated`はwebのみ、workerは`--no-allow-unauthenticated`） | 既存認証モジュール流用 | G0以降で実装 |

## 5. うまくいかない場合の切り分け

1. `01_setup_project.sh`で失敗 → `BILLING_ACCOUNT_ID`未設定、または組織ポリシーでプロジェクト作成が制限されていないか確認
2. `02_create_sql.sh`で失敗 → `sqladmin.googleapis.com`の有効化が反映されるまで数十秒待って再実行
3. `04_build_push.sh`で失敗 → `gcloud builds submit`のログURLが出力されるので開いてビルドエラーを確認（pnpm installの失敗が多い場合はNode/pnpmバージョン起因の可能性）
4. `06_deploy_run.sh`後、`07_smoke_test.sh`で`db":"ng"` → `.gcp-sql-connection-name`の内容とCloud RunのSecret(`inspexor-database-url`)の値を確認。`gcloud run services logs read inspexor-web --region asia-northeast1`でエラーログを確認
