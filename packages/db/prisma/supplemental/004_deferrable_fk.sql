-- ============================================================
-- 004_deferrable_fk.sql
-- schema.sql 29行目・34行目より一字一句そのまま。
-- work_reports.current_revision_id / delivery_reports.current_revision_id は
-- 対応するrevisionテーブルへの循環参照FKであり、report作成→revision作成→
-- current_revision_id更新、の順で1トランザクション内に収めるためDEFERRABLE
-- INITIALLY DEFERREDが必須（そうでないとreport作成時点でFK違反になる）。
-- Prisma schema言語にDEFERRABLE指定の表現手段が無いため、Prisma生成migrationの
-- 通常FK（NOT DEFERRABLE）をこの内容で明示的に置き換える必要がある。
-- 【適用手順】Prismaが生成した以下相当のFKが既にあれば先にDROPしてから実行する:
--   ALTER TABLE app.work_reports DROP CONSTRAINT IF EXISTS work_reports_current_revision_id_fkey;
--   ALTER TABLE app.delivery_reports DROP CONSTRAINT IF EXISTS delivery_reports_current_revision_id_fkey;
-- （実際に生成される制約名はPrismaのバージョン/命名規則により変わるため、
--   `prisma migrate dev --create-only` 実行後に生成SQLを目視確認してから適用すること）
-- ============================================================

ALTER TABLE app.work_reports
  ADD CONSTRAINT work_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES app.work_report_revisions(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE app.delivery_reports
  ADD CONSTRAINT delivery_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES app.delivery_report_revisions(id)
  DEFERRABLE INITIALLY DEFERRED;
