-- CHG-001: マスタ10種の楽観ロック・監査列・無効化列の追加（schema.sql への追記migration）
-- 根拠: DB設計書 方針「全mutable headerにversion/created_at/updated_at」、共通制約「version>=1」、
--       各表の主要列（#4〜#13 に version 記載）、API MasterUpdate/Command の expectedVersion 必須、
--       REQ-MST-001「参照済み物理削除不可」→ 無効化(active=false)で表現。
-- 方式: expand のみ（既存列・既存データを変更しない）。適用済みmigrationの編集禁止。
BEGIN;

-- 1) version / created_at / updated_at（customers は既存のため対象外）
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_contacts','workers','products','work_types','defect_types',
                           'holidays','rate_rules','transport_rules','fixed_charge_rules']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1', t);
    EXECUTE format('ALTER TABLE app.%I ADD CONSTRAINT %I CHECK (version >= 1)', t, t || '_version_positive');
    EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()', t);
    EXECUTE format('ALTER TABLE app.%I ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()', t);
  END LOOP;
END $$;
ALTER TABLE app.customers ADD CONSTRAINT customers_version_positive CHECK (version >= 1);

-- 2) holidays: API path {id} は uuid のため代理キーを追加（holiday_date の PK は維持）。無効化用 active
ALTER TABLE app.holidays ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE app.holidays ADD CONSTRAINT holidays_id_unique UNIQUE (id);
ALTER TABLE app.holidays ADD COLUMN active boolean NOT NULL DEFAULT true;

-- 3) rule 3表: 無効化用 active。期間重複排除は有効rowのみに限定（無効化済みruleが新ruleを妨げない）
ALTER TABLE app.rate_rules ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE app.transport_rules ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE app.fixed_charge_rules ADD COLUMN active boolean NOT NULL DEFAULT true;

ALTER TABLE app.rate_rules DROP CONSTRAINT rate_no_overlap;
ALTER TABLE app.rate_rules ADD CONSTRAINT rate_no_overlap EXCLUDE USING gist(
  product_id WITH =,
  (COALESCE(work_type_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[]')) WITH &&
) WHERE (active);

ALTER TABLE app.transport_rules DROP CONSTRAINT transport_no_overlap;
ALTER TABLE app.transport_rules ADD CONSTRAINT transport_no_overlap EXCLUDE USING gist(
  product_id WITH =,
  (COALESCE(work_type_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  type WITH =,
  (daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[]')) WITH &&
) WHERE (active);

-- DB設計書#13「期間overlap exclusion」が schema.sql に未実装だったため追加（品番＋ラベル単位）
ALTER TABLE app.fixed_charge_rules ADD CONSTRAINT fixed_charge_no_overlap EXCLUDE USING gist(
  product_id WITH =,
  label WITH =,
  (daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[]')) WITH &&
) WHERE (active);

-- 4) DB設計書「email lower-case」
ALTER TABLE app.customer_contacts ADD CONSTRAINT customer_contacts_email_lower CHECK (email = lower(email));

-- 5) 一覧用索引（DB設計書「主要一覧filter」）
CREATE INDEX rate_rules_product ON app.rate_rules(product_id, valid_from);
CREATE INDEX transport_rules_product ON app.transport_rules(product_id, valid_from);
CREATE INDEX fixed_charge_rules_product ON app.fixed_charge_rules(product_id, valid_from);
CREATE INDEX products_customer ON app.products(customer_id);
CREATE INDEX customer_contacts_customer ON app.customer_contacts(customer_id);

-- 6) migration 適用記録
CREATE TABLE IF NOT EXISTS app.schema_migrations(
  id varchar(100) PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app.schema_migrations(id) VALUES ('0001_chg001_master_columns');

COMMIT;
