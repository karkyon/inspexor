-- ============================================================
-- 002_check_constraints.sql
-- schema.sql の全CHECK句(27件)をALTER TABLE ADD CONSTRAINTとして再構成。
-- 一字一句、schema.sqlの式をそのまま使用（推測・改変なし）。
-- 【適用手順】Prisma生成migrationでテーブルが作成された【後】に追記する。
-- 制約名は "<table>_<col_or_desc>_check" で統一命名（schema.sql上は無名インライン
-- CHECKだったため、運用上の可読性のために付与。DDLの意味・条件式は不変）。
-- ============================================================

-- 1. users (schema.sql 12行目)
ALTER TABLE app.users
  ADD CONSTRAINT users_failed_attempts_check CHECK (failed_attempts >= 0);

-- 2. customers (14行目)
ALTER TABLE app.customers
  ADD CONSTRAINT customers_closing_day_check CHECK (closing_day BETWEEN 1 AND 31);

-- 3. product_contacts (18行目)
ALTER TABLE app.product_contacts
  ADD CONSTRAINT product_contacts_purpose_check CHECK (purpose IN ('DAILY', 'INVOICE'));

-- 4. rate_rules (22行目) — 3件
ALTER TABLE app.rate_rules
  ADD CONSTRAINT rate_rules_unit_price_check CHECK (unit_price >= 0);
ALTER TABLE app.rate_rules
  ADD CONSTRAINT rate_rules_overtime_multiplier_check CHECK (overtime_multiplier >= 1);
ALTER TABLE app.rate_rules
  ADD CONSTRAINT rate_rules_valid_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- 5. transport_rules (24行目) — 2件
ALTER TABLE app.transport_rules
  ADD CONSTRAINT transport_rules_amount_yen_check CHECK (amount_yen >= 0);
ALTER TABLE app.transport_rules
  ADD CONSTRAINT transport_rules_valid_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- 6. fixed_charge_rules (26行目) — 2件
ALTER TABLE app.fixed_charge_rules
  ADD CONSTRAINT fixed_charge_rules_amount_yen_check CHECK (amount_yen >= 0);
ALTER TABLE app.fixed_charge_rules
  ADD CONSTRAINT fixed_charge_rules_valid_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- 7. work_report_revisions (28行目) — 7件
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_break_minutes_check CHECK (break_minutes >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_regular_minutes_check CHECK (regular_minutes >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_overtime_minutes_check CHECK (overtime_minutes >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_regular_person_minutes_check CHECK (regular_person_minutes >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_overtime_person_minutes_check CHECK (overtime_person_minutes >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_quantity_check CHECK (quantity >= 0);
ALTER TABLE app.work_report_revisions
  ADD CONSTRAINT work_report_revisions_end_after_start_check CHECK (end_at > start_at);

-- 8. defect_results (31行目)
ALTER TABLE app.defect_results
  ADD CONSTRAINT defect_results_quantity_check CHECK (quantity >= 0);

-- 9. delivery_items (35行目)
ALTER TABLE app.delivery_items
  ADD CONSTRAINT delivery_items_quantity_check CHECK (quantity > 0);

-- 10. approvals (36行目) — 3件
ALTER TABLE app.approvals
  ADD CONSTRAINT approvals_entity_type_check CHECK (entity_type IN ('WORK', 'DELIVERY'));
ALTER TABLE app.approvals
  ADD CONSTRAINT approvals_result_check CHECK (result IN ('APPROVE', 'REJECT', 'REVOKE'));
ALTER TABLE app.approvals
  ADD CONSTRAINT approvals_reason_required_check CHECK (result = 'APPROVE' OR length(trim(reason)) > 0);

-- 11. invoice_recipients (40行目)
ALTER TABLE app.invoice_recipients
  ADD CONSTRAINT invoice_recipients_recipient_type_check CHECK (recipient_type IN ('TO', 'CC', 'BCC'));

-- 12. files (41行目)
ALTER TABLE app.files
  ADD CONSTRAINT files_size_bytes_check CHECK (size_bytes >= 0);

-- 13. idempotency_records (45行目)
ALTER TABLE app.idempotency_records
  ADD CONSTRAINT idempotency_records_status_check CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED'));

-- 14. billing_warnings (46行目) — 2件
ALTER TABLE app.billing_warnings
  ADD CONSTRAINT billing_warnings_resolution_check CHECK (resolution IN ('ACCEPT', 'EXCLUDE', 'CORRECT_SOURCE'));
ALTER TABLE app.billing_warnings
  ADD CONSTRAINT billing_warnings_resolution_resolved_at_check CHECK ((resolution IS NULL) = (resolved_at IS NULL));
