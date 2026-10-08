# CHG-002 現場入力（G3）の API 契約是正・listRecords 権限・報告番号の基準月

| 項目 | 内容 |
|---|---|
| CHG ID | CHG-002 |
| 起票日 | 2026-10-08 |
| 起票者 | Claude（Developer） |
| 承認 | 2026-10-08 利用者回答「提案どおり承認」（Claude は承認権なし） |
| 状態 | APPROVED |
| 解消する未決事項 | SPEC-CONFLICT-G3-02（FIELD の自分の履歴）、SPEC-CONFLICT-G3-03（WorkUpdate/DeliveryUpdate が全件不合格）、SPEC-CONFLICT-G3-04（Detail 応答が openapi に無い）、GAP-015（報告番号の基準月） |
| 残る未決事項 | SPEC-CONFLICT-G3-01（代理入力: 代理理由の項目・報告者一覧 API が無い）→ 別 CHG。G3 は報告者=本人のみ |
| 影響ID | FR-002, FR-003, FR-016, REQ-DLV-001, REQ-WRK-001, REQ-OFF-001, API-004〜012, SCR-02〜09 |
| Gate | G3 Field |

## 1. 理由

1. `WorkUpdate` / `DeliveryUpdate` は `allOf: [WorkDraft, {required: [expectedVersion]}]`。`WorkDraft` 側が `additionalProperties: false` のため `expectedVersion` が未知項目扱いになり、**正しい更新要求も含めて全件が schema 不合格**（ajv で確認）。
2. API設計書 API-005/009 の成功応答 `WorkReportDetail` / `DeliveryDetail` が openapi に未定義（openapi は `Record` = id/status/version のみで、下書きの再開・確認画面に必要な内容を返せない）。
3. 業務要件 §2 は「自分の下書き/確定/履歴: FIELD=CRUD」、画面外部仕様 SCR-02 は API=listRecords だが、RBAC（API-012）は OFFICE/ADMIN/AUDITOR のみで FIELD は 403。
4. 用語定義書 reportNo=`WR|DR-YYYYMM-6桁sequence` の YYYYMM の基準日が未定義。

## 2. 変更内容

### 2.1 openapi（`3.1.0-CHG-002`）

| 対象 | 変更 |
|---|---|
| WorkUpdate / DeliveryUpdate | WorkDraft / DeliveryDraft の全項目＋`expectedVersion` を持つ平坦な object（`additionalProperties: false`）に置換。受理する値は従来の意図と同じ |
| WorkReportDetail / DeliveryReportDetail（新規 schema・response） | GET API-005/009 の 200 応答。header（id, reportNo, status, version, documentStatus, ownerId）＋最新 revision（revisionId, revisionNo, parentRevisionId, confirmedAt）＋業務項目。作業は計算済みの分（break/regular/overtime/regularPerson/overtimePerson）、運搬は明細ごとの allocationEligible を含む |
| Record | 任意項目 `type`（WORK/DELIVERY）、`businessDate`、`revisionNo` を追加（一覧表示用。必須項目は不変） |

endpoint・DB 列・状態の追加はなし。

### 2.2 RBAC（API-012 listRecords）

FIELD を追加。FIELD は repository で `owner_id = 本人` に限定する（他人の行は返さない）。OFFICE/ADMIN/AUDITOR は従来どおり全件。

### 2.3 報告番号

`WR|DR-YYYYMM-NNNNNN` の YYYYMM は **作成日（JST）の月**。月×種別ごとに 000001 から採番（同月の最大番号＋1、採番は transaction 内の advisory lock で直列化）。作成後に業務日を変更しても番号は変えない。

## 3. 実装上の判断（本 CHG の範囲内）

| No | 判断 |
|---|---|
| D1 | 下書きは端末（sessionStorage）で step を進め、最終 step で POST（初回）または PATCH（2回目以降）→ confirm。WorkDraft/DeliveryDraft は全項目必須のため Step1 時点では server に保存できない |
| D2 | 未確定 revision（confirmed_at IS NULL）を header ごとに最大1件持ち、PATCH はそれを更新。confirm で confirmed_at を設定（以後 DB trigger で不変）し current_revision_id を更新、status=CONFIRMED、outbox に WorkReportConfirmed / DeliveryReportConfirmed |
| D3 | 運搬明細の allocation_eligible は confirm 時に「運搬日に有効な ALLOCATED の運搬ルールが品番にあるか」で確定（GAP-016: 仕様に判定式の明記なし） |
| D4 | 画面仕様の上限（作業者 1–50、数量 0–999999、運搬数量 1–999999）は openapi に無いため、schema ではなく業務検証（422）で適用 |
| D5 | 作業時間は JST の作業日内（日跨ぎ不可、終了は翌日 0:00 まで）、5分刻み。分の計算は domain `computeBusinessTime`（休日 master の有効行を参照） |

## 4. 検証

- ajv: 修正後 WorkUpdate / DeliveryUpdate が正常 body を受理し、未知項目・必須欠落を拒否（contract test）
- RBAC: FIELD の listRecords 可、owner 絞込みは統合試験で確認
