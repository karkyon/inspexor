# CHG-003 運搬実績の帳票（DELIVERY_REPORT_V1）と帳票 API の補足

| 項目 | 内容 |
|---|---|
| CHG ID | CHG-003 |
| 起票日 | 2026-10-08 |
| 起票者 | Claude（Developer） |
| 承認 | 2026-10-08 利用者回答「CHG-003で運搬帳票を追加」（Claude は承認権なし） |
| 状態 | APPROVED |
| 解消する未決事項 | SPEC-CONFLICT-G4-01（運搬の帳票が未定義のため CONFIRMED→SUBMITTED に進めない） |
| 影響ID | FR-002, FR-005, FR-006, FR-018, REQ-DOC-001, API-005/009/024/025, SEC-013 |
| Gate | G4 Document |

## 1. 理由

1. 帳票・メール定義書の template は DAILY_REPORT_V1（作業日報）と請求書2種のみ。FR-002（運搬入力）の出力は「PDF job」、状態遷移 CONFIRMED→SUBMITTED は「PDF hash 有」が条件のため、運搬は帳票が無いと承認待ちに進めない。
2. GET 応答（WorkReportDetail / DeliveryReportDetail）には documentStatus はあるが、帳票（API-024）を引く id が無い。

## 2. 変更内容

### 2.1 帳票 template（追加）

`DELIVERY_REPORT_V1`（fixture A4 HTML: `apps/worker/templates/delivery-report-v1.html`）

| placeholder | 内容 |
|---|---|
| report_no / revision_no | 報告番号 / 版 |
| delivery_date | 運搬日 |
| driver_name | 運転者 |
| customer_code / customer_name | お客様 |
| item_rows | 品番・品名・数量の行（品番コード順） |
| item_count / total_quantity | 品番数 / 合計数量 |
| confirmed_at | 確定日時（JST） |

- filename: `運搬_YYYY-MM-DD_customerCode_reportNo_rN.pdf`
- **メール送信はしない**（送信仕様は日報のみ。API-025 send は運搬帳票に対して 409）
- 作業日報と同じ経路（outbox → document job → PDF → storage → SUBMITTED）

### 2.2 openapi（`3.1.0-CHG-003`）

WorkReportDetail / DeliveryReportDetail に `documentId`（最新 revision の最新帳票 job の id、無ければ null）を追加し、`documentStatus` を実値（job status）で返す。endpoint・DB 列・状態の追加なし。

## 3. 実装上の判断（G4 範囲決定: 開発環境で全経路）

| No | 判断 |
|---|---|
| D1 | PDF は fixture HTML を headless Chromium（playwright-core）で A4 印刷。日本語フォントは Noto Sans JP（@fontsource）を同梱し端末依存を無くす。外部ネットワーク要求は遮断 |
| D2 | 開発環境の enqueue は document_jobs への登録（Cloud Tasks は G9）。worker（apps/worker）が常駐し outbox / 帳票 / メールを SKIP LOCKED で処理 |
| D3 | storage は LocalFsStorage（`STORAGE_DIR`、既定 `~/.inspexor-storage`）。API-024 の署名付き URL は web の `/api/files/{fileId}?exp&sig`（HMAC、10分）。`STORAGE_BUCKET` 設定時は無効（Cloud Storage は G9） |
| D4 | mail は Mailpit adapter（HTTP API）。Message-ID を冪等 key から決め、再試行前に provider を検索して二重送信を防ぐ（T-MAIL-001）。Gmail adapter は G9（EXT-03） |
| D5 | retry は network/408/429/5xx 相当のみ、10s/30s/2m/10m/30m、retry 最大5回（初回＋5回）。待機判定は `updated_at` と試行回数（job に次回時刻列が無いため） |
| D6 | document id = document_jobs.id。API-025 の expectedVersion は元実績（root）の version と照合（document_jobs に version 列が無い: GAP-019）。regenerate / send / retry は理由必須、新 job を作り旧版は保持。job 作成は worker（outbox: DocumentRequested / MailRequested） |
| D7 | 日報メールの宛先は「品番の DAILY 担当かつ send_daily の有効な連絡先」を帳票生成時に snapshot。0件は帳票まで作成し送信は FAILED_FINAL（RECIPIENT_EMPTY） |
| D8 | 手動 regenerate した帳票は自動送信しない（送る場合は send） |
