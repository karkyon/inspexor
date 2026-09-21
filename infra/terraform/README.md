# infra/terraform

GCP (Cloud Run / Cloud SQL / Tasks / Storage) のTerraform IaC。
asia-northeast1固定。dev/stg/prodはproject分離、state分離。
console上での手動変更（drift）禁止（開発スタック定義書 5章）。
実ファイルはG0以降、インフラ・運用設計書 v5.1 に基づき作成する。
