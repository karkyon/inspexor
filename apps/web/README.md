# apps/web

## 責務
UI（画面外部仕様書 準拠）とREST API（openapi.yaml 準拠）、認証。

## 禁止（開発スタック定義書 5章）
- domainのtableに直接アクセスしない。必ずpackages/application経由。
