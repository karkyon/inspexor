-- CHG-001 rollback（expandのみのため列削除で戻せる。G2実装のdeploy前に限る。deploy後はforward-fix）
BEGIN;
DROP INDEX IF EXISTS app.rate_rules_product, app.transport_rules_product, app.fixed_charge_rules_product,
  app.products_customer, app.customer_contacts_customer;
ALTER TABLE app.customer_contacts DROP CONSTRAINT IF EXISTS customer_contacts_email_lower;
ALTER TABLE app.fixed_charge_rules DROP CONSTRAINT IF EXISTS fixed_charge_no_overlap;
ALTER TABLE app.rate_rules DROP CONSTRAINT rate_no_overlap;
ALTER TABLE app.rate_rules ADD CONSTRAINT rate_no_overlap EXCLUDE USING gist(product_id WITH =,(COALESCE(work_type_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,(daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[]')) WITH &&);
ALTER TABLE app.transport_rules DROP CONSTRAINT transport_no_overlap;
ALTER TABLE app.transport_rules ADD CONSTRAINT transport_no_overlap EXCLUDE USING gist(product_id WITH =,(COALESCE(work_type_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,type WITH =,(daterange(valid_from,COALESCE(valid_to,'infinity'::date),'[]')) WITH &&);
ALTER TABLE app.rate_rules DROP COLUMN active;
ALTER TABLE app.transport_rules DROP COLUMN active;
ALTER TABLE app.fixed_charge_rules DROP COLUMN active;
ALTER TABLE app.holidays DROP COLUMN active, DROP COLUMN id;
ALTER TABLE app.customers DROP CONSTRAINT IF EXISTS customers_version_positive;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_contacts','workers','products','work_types','defect_types',
                           'holidays','rate_rules','transport_rules','fixed_charge_rules']
  LOOP
    EXECUTE format('ALTER TABLE app.%I DROP COLUMN IF EXISTS version, DROP COLUMN IF EXISTS created_at, DROP COLUMN IF EXISTS updated_at', t);
  END LOOP;
END $$;
DELETE FROM app.schema_migrations WHERE id = '0001_chg001_master_columns';
COMMIT;
