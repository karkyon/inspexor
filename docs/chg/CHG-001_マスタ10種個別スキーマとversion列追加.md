# CHG-001 マスタ10種の個別APIスキーマ・version列追加・遡及影響preview

| 項目 | 内容 |
|---|---|
| CHG ID | CHG-001 |
| 起票日 | 2026-10-08 |
| 起票者 | Claude（Developer） |
| 承認者 | Tech Lead / 業務責任者（承認権者。Claude は承認権なし） |
| 状態 | PROPOSED |
| 解消する未決事項 | SPEC-CONFLICT-G2-01（マスタAPI共通body）、SPEC-CONFLICT-G2-02（version列欠落） |
| 影響ID | FR-008, REQ-MST-001, API-014〜018, SCR-13, DB設計書#3〜13, SEC-027, T-MST-001 |
| Gate | G2 Master |

## 1. 理由

1. v6.0 再監査報告書 AUD-003（P0）は「10マスターが共通body → 必須項目・型を推測」を欠陥とし、oneOf による個別定義へ是正したと記載しているが、v6.0 版 openapi.yaml はナレッジに存在しない（現行は 3.0.0・共通 `MasterWrite`）。
2. API の `MasterUpdate` / `Command` は `expectedVersion` 必須、DB設計書も「全mutable headerに version/created_at/updated_at」とするが、`schema.sql` では customers 以外のマスタに version 列が無い。
3. REQ-MST-001「参照済み物理削除不可」「遡及影響preview」を満たす列・APIが無い（休日・rule 3表に無効化列なし、previewのendpoint無し）。

## 2. 変更内容

### 2.1 DB（`docs/spec/migrations/0001_chg001_master_columns.sql`、追記のみ）

| 対象 | 変更 | 根拠 |
|---|---|---|
| customer_contacts, workers, products, work_types, defect_types, holidays, rate_rules, transport_rules, fixed_charge_rules | `version int NOT NULL DEFAULT 1 CHECK(version>=1)`、`created_at`、`updated_at` 追加 | DB設計書 方針・共通制約 |
| customers | `CHECK(version>=1)` 追加 | 共通制約 |
| holidays | 代理キー `id uuid UNIQUE`（PK `holiday_date` は維持）、`active` 追加 | openapi の path `{id}` が uuid |
| rate_rules / transport_rules / fixed_charge_rules | `active` 追加。期間重複排除を **有効rowのみ** に限定 | 無効化済みruleが後継ruleを妨げないため |
| fixed_charge_rules | 期間重複排除（品番＋ラベル）を新設 | DB設計書#13「期間overlap exclusion」が schema.sql に未実装 |
| customer_contacts | `CHECK(email = lower(email))` | DB設計書「email lower-case」 |
| 索引 | rule 3表（product_id, valid_from）、products(customer_id)、customer_contacts(customer_id) | 「主要一覧filter」 |
| app.schema_migrations | 適用記録表を新設 | 適用済みmigrationの二重適用防止 |

rollback: `0001_chg001_master_columns.rollback.sql`（G2 deploy 前のみ。deploy後は forward-fix）。

### 2.2 API（`docs/spec/openapi.yaml` → version `3.1.0-CHG-001`）

- `MasterWrite` / `MasterUpdate` を 10種の個別schemaの `oneOf` に置換（各 `additionalProperties: false`）。path の `type` → schema の対応は `x-inspexor-type-map`。
- `MasterRecord`（id/version/active/createdAt/updatedAt）、`MasterImpact`（遡及影響）の応答schemaを追加。
- `PATCH` / `DELETE /masters/{type}/{id}` に query `preview=true` を追加：更新・無効化を行わず遡及影響を返す。
- path数20・operation数25は不変（新endpoint追加なし）。

| type | schema | 必須 | 任意 |
|---|---|---|---|
| customers | CustomerWrite | code(≤30), name(≤200), closingDay(1–31) | active |
| contacts | ContactWrite | customerId, code(≤30), name(≤100), email | sendDaily, sendInvoice, dailyProductIds[], invoiceProductIds[], active |
| workers | WorkerWrite | code(≤30), name(≤100) | active |
| products | ProductWrite | customerId, code(≤80), name(≤200), settlementType(QUANTITY/TIME) | lotRequired, active |
| work-types | WorkTypeWrite | productId, code(≤50), name(≤200) | active |
| defects | DefectTypeWrite | productId, code(≤50), name(≤100), sortOrder(≥0) | active |
| holidays | HolidayWrite | holidayDate, name(≤100) | active |
| rates | RateRuleWrite | productId, unitPrice(10進文字列 ≤14桁.≤4桁), validFrom | workTypeId, overtimeMultiplier(既定"1.25"), validTo, active |
| transport-rules | TransportRuleWrite | productId, transportType(4区分), amountYen(≥0), validFrom | workTypeId, allocationGroup, validTo, active |
| fixed-charges | FixedChargeWrite | productId, label(≤200), amountYen(≥0), validFrom | validTo, active |

更新は各 `*Update` = 上記＋`expectedVersion(≥1)`＋`reason(1–1000)`。

## 3. 承認が必要な設計判断

| No | 判断 | 採用案 | 代替案 |
|---|---|---|---|
| D1 | 単価・倍率の型 | 10進**文字列**（JS number 禁止＝00契約§1、既存 MasterWrite.unitPrice と同形式） | number |
| D2 | 担当品番（product_contacts）の管理 | contacts の `dailyProductIds` / `invoiceProductIds` で一括置換 | 独立した master type 追加（10種を超える） |
| D3 | defects の `sortOrder` | **必須**（workTypes と body を区別し oneOf を一意にするため） | 任意＋既定0（oneOf が曖昧になる） |
| D4 | 休日・rule の削除 | 物理削除せず `active=false`（REQ-MST-001） | rule は validTo を前日に設定 |
| D5 | 固定費の重複排除単位 | 品番＋ラベル＋期間 | 品番＋期間（1品番1固定費） |
| D6 | 遡及影響preview | 既存 PATCH/DELETE に `?preview=true` | 新endpoint `/impact` |
| D7 | 遡及変更の判定 | 変更後の適用期間が「今日（JST）より前」に掛かる rule 変更を遡及とし、reason必須・auditに `retroactive=true` を記録。確定済み請求（snapshot）は変更しない | 承認ワークフロー追加（MVP外） |
| D8 | SEC-026 遡及変更時の再認証 | **本CHGの対象外**。MFA（SPEC-CONFLICT-G1-03）と同時に別CHGで決定 | 本CHGでパスワード再入力を追加 |

## 4. 検証結果（PostgreSQL 16.15、2026-10-08）

| 検証 | 結果 |
|---|---|
| fresh: schema.sql → migration | PASS |
| upgrade: 既存データありDB → migration（既存rowは version=1 で補完） | PASS |
| 有効ruleの期間重複 | 拒否（rate_no_overlap） |
| 無効化後の同期間登録 | 許可 |
| 固定費 同品番＋同ラベル重複 / 別ラベル | 拒否 / 許可 |
| version=0、大文字email | 拒否 |
| 二重適用 | 拒否 |
| rollback 後の構造 | schema.sql と差分0（schema_migrations 表のみ残置） |
| 10種サンプルbody が各1 schemaにだけ一致（Write/Update） | 10/10 |
| 境界・拒否（未知field、closingDay 32、単価5桁小数・number型、負額、不正区分、reason欠落、version 0） | 8/8 |
| API項目 → DB列の対応（migration適用後） | 10/10 |
| 既存 contract test（G0/G1） | 73/73 |

## 5. 承認後の実施手順

1. 本CHGを `INSPEXOR_未決事項・変更管理台帳` Change_Log に APPROVED で記録
2. G2 バッチ：migration を開発DB（Cloud SQL）と統合テストの fresh DB に適用
3. マスタ10種の CRUD・無効化・参照保護・遡及preview・audit の実装と、T-MST-001 系の unit / contract / integration / E2E
4. SPEC-CONFLICT-G2-01/02 を CLOSED（CHG-001）に更新
