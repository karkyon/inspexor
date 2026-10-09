-- CHG-004 D1/D2: 提案書 SK-2026-08-MINI の入力項目
--   マスタ「車両」「作業場所」、作業報告の作業場所・使用車・備考、運搬報告の使用車両・運搬回数、運搬費（運搬報告1件に1金額）
-- 方式: expand のみ（既存列・既存データは変更しない。既存行の新列は NULL／運搬回数は 1）。適用済み migration の編集禁止。
BEGIN;

CREATE TABLE app.vehicles(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1 CONSTRAINT vehicles_version_positive CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.work_locations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(30) NOT NULL UNIQUE,
  name varchar(100) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1 CONSTRAINT work_locations_version_positive CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 作業報告（revision に保持＝確定後は不変）
ALTER TABLE app.work_report_revisions
  ADD COLUMN work_location_id uuid REFERENCES app.work_locations(id),
  ADD COLUMN vehicle_id uuid REFERENCES app.vehicles(id),
  ADD COLUMN remarks varchar(500);

-- 運搬報告（revision に保持）
ALTER TABLE app.delivery_report_revisions
  ADD COLUMN vehicle_id uuid REFERENCES app.vehicles(id),
  ADD COLUMN trip_count int NOT NULL DEFAULT 1 CONSTRAINT delivery_trip_count_range CHECK (trip_count BETWEEN 1 AND 99);

-- 運搬費: 運搬報告1件に1金額（D2）。空欄（NULL）可、事務所が後から入力・修正。版は作らず header の version と監査で管理
ALTER TABLE app.delivery_reports
  ADD COLUMN delivery_fee_yen bigint CONSTRAINT delivery_fee_range CHECK (delivery_fee_yen IS NULL OR delivery_fee_yen BETWEEN 0 AND 9999999);

CREATE INDEX work_report_revisions_location ON app.work_report_revisions(work_location_id);
CREATE INDEX work_report_revisions_vehicle ON app.work_report_revisions(vehicle_id);
CREATE INDEX delivery_report_revisions_vehicle ON app.delivery_report_revisions(vehicle_id);

INSERT INTO app.schema_migrations(id) VALUES ('0002_chg004_field_items');

COMMIT;
