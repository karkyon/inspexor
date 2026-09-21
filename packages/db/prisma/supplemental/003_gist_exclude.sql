-- ============================================================
-- 003_gist_exclude.sql
-- schema.sql 23行目・25行目より一字一句そのまま。
-- rate_rules/transport_rulesの「同一product(+work_type)で有効期間が重複するruleを
-- 複数登録できない」という業務制約。btree_gist拡張が前提（001_extensions.sqlで導入済み）。
-- Prisma schema言語にEXCLUDE制約の表現手段が無いため、Prisma生成migrationの後に追記する。
-- ============================================================

ALTER TABLE app.rate_rules
  ADD CONSTRAINT rate_no_overlap EXCLUDE USING gist(
    product_id WITH =,
    (COALESCE(work_type_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[]')) WITH &&
  );

ALTER TABLE app.transport_rules
  ADD CONSTRAINT transport_no_overlap EXCLUDE USING gist(
    product_id WITH =,
    (COALESCE(work_type_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    type WITH =,
    (daterange(valid_from, COALESCE(valid_to, 'infinity'::date), '[]')) WITH &&
  );
