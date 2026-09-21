-- ============================================================
-- 005_immutability_triggers.sql
-- schema.sql 58-62行目より一字一句そのまま。
-- 00契約 3.1「確定revision、確定invoice、audit eventはUPDATE/DELETE不可」を
-- DBレベルで強制する不変トリガー。アプリケーション側のバグやSQLの直接実行からも
-- 確定データを保護する最終防衛線。Prisma schema言語にトリガー定義の表現手段が
-- 無いため、Prisma生成migrationの後に追記する。
-- ============================================================

CREATE FUNCTION app.reject_immutable_revision_update() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'confirmed revision is immutable' USING ERRCODE = '55000';
  END
$$;

CREATE TRIGGER work_revision_immutable
  BEFORE UPDATE OR DELETE ON app.work_report_revisions
  FOR EACH ROW
  WHEN (OLD.confirmed_at IS NOT NULL)
  EXECUTE FUNCTION app.reject_immutable_revision_update();

CREATE TRIGGER delivery_revision_immutable
  BEFORE UPDATE OR DELETE ON app.delivery_report_revisions
  FOR EACH ROW
  WHEN (OLD.confirmed_at IS NOT NULL)
  EXECUTE FUNCTION app.reject_immutable_revision_update();

CREATE FUNCTION app.reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '55000';
  END
$$;

CREATE TRIGGER audit_append_only
  BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION app.reject_audit_mutation();
