-- 0002 の rollback（本番適用後は forward-fix。開発環境で新列に値が入る前のみ）
BEGIN;
DROP INDEX IF EXISTS app.delivery_report_revisions_vehicle;
DROP INDEX IF EXISTS app.work_report_revisions_vehicle;
DROP INDEX IF EXISTS app.work_report_revisions_location;
ALTER TABLE app.delivery_reports DROP COLUMN delivery_fee_yen;
ALTER TABLE app.delivery_report_revisions DROP COLUMN trip_count, DROP COLUMN vehicle_id;
ALTER TABLE app.work_report_revisions DROP COLUMN remarks, DROP COLUMN vehicle_id, DROP COLUMN work_location_id;
DROP TABLE app.work_locations;
DROP TABLE app.vehicles;
DELETE FROM app.schema_migrations WHERE id = '0002_chg004_field_items';
COMMIT;
