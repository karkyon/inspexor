# packages/db/prisma/supplemental — 適用手順

このディレクトリのSQLは、`schema.prisma`（Prisma schema言語）では表現できない
schema.sql正本の制約を、Prisma Migrateのワークフローに手動で組み込むためのものです。
全て`schema.sql`から一字一句そのまま抽出し、機械突合せ済みです（推測・改変なし）。

## なぜ必要か

Prisma schema言語には以下の表現手段がありません。
- CHECK制約（27件）
- GIST EXCLUDE制約（期間重複防止、2件）
- DEFERRABLE INITIALLY DEFERRED FK（循環参照FK、2件）
- トリガー・トリガー関数（不変性強制、2組）

これらを欠いたままmigrateすると、実DBがschema.sqlの業務制約を満たさなくなります
（00契約 4章 Gate停止条件「OpenAPI/DB drift」に抵触）。

## 適用手順（Cloud Shell、実際のCloud SQLに対して）

```bash
cd ~/inspexor
export DATABASE_URL="<Cloud SQL Auth Proxy経由の接続文字列>"

# 1. Prismaでmigrationを生成する（まだ適用しない: --create-only）
pnpm --filter @inspexor/db exec prisma migrate dev --name init --create-only --schema packages/db/prisma/schema.prisma
```

生成される `packages/db/prisma/migrations/<timestamp>_init/migration.sql` を編集する。

```bash
MIGRATION_FILE=$(ls -d packages/db/prisma/migrations/*_init)/migration.sql

# 2. 先頭に拡張機能を挿入（CREATE SCHEMA/TABLEより前）
cat packages/db/prisma/supplemental/001_extensions.sql "$MIGRATION_FILE" > /tmp/migration_new.sql
mv /tmp/migration_new.sql "$MIGRATION_FILE"

# 3. 末尾にCHECK制約・GIST EXCLUDE・DEFERRABLE FK・トリガーを追記
cat packages/db/prisma/supplemental/002_check_constraints.sql >> "$MIGRATION_FILE"
cat packages/db/prisma/supplemental/003_gist_exclude.sql >> "$MIGRATION_FILE"
cat packages/db/prisma/supplemental/004_deferrable_fk.sql >> "$MIGRATION_FILE"
cat packages/db/prisma/supplemental/005_immutability_triggers.sql >> "$MIGRATION_FILE"

# 4. 適用前に必ず目視で migration.sql を確認する
#    （004_deferrable_fk.sql のコメントにある通り、Prismaが生成した
#      current_revision_id の通常FKを先にDROPしてから追加FKを効かせる必要がある。
#      Prismaの命名規則で生成された制約名を確認し、必要ならDROP文を追加する）
less "$MIGRATION_FILE"

# 5. 適用する
pnpm --filter @inspexor/db exec prisma migrate resolve --applied "$(basename $(dirname "$MIGRATION_FILE"))" --schema packages/db/prisma/schema.prisma 2>/dev/null || true
pnpm --filter @inspexor/db exec prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

## 検証（fresh/upgrade drift チェック）

00契約 4章のGate停止条件「migration fresh/upgrade失敗」を満たさないことを確認する。

```bash
# fresh: クリーンなDBに対して全migrationが通ること
pnpm --filter @inspexor/db exec prisma migrate deploy --schema packages/db/prisma/schema.prisma

# schema.sqlとの構造diff（テーブル/カラムの機械突合せ。本リポジトリのG0-MIGRATIONで実施した
# 方法と同じ）
pnpm --filter @inspexor/db migration:check
```

## 既知の制約・要確認事項

- `prisma migrate dev`の`--create-only`は対話式の確認を挟む場合がある。CI/自動化では
  `prisma migrate diff` + 手動SQL適用への切り替えも検討する（G8-EVIDENCE時に再検討）。
- Prismaが生成するFK制約名はPrismaのバージョンにより変わりうるため、004実行前に
  必ず実際の制約名を確認すること（DROP対象を推測で決め打ちしない）。
