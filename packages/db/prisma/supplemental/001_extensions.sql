-- ============================================================
-- 001_extensions.sql
-- schema.sql 2-3行目より一字一句そのまま。
-- 【適用手順】`prisma migrate dev --create-only` で生成された
-- migrations/<timestamp>_init/migration.sql の【先頭】に、
-- CREATE SCHEMA文より前の位置でこの内容を貼り付ける。
-- pgcrypto: gen_random_uuid()（全テーブルのid列で使用）に必須。
-- btree_gist: rate_rules/transport_rulesのGIST EXCLUDE制約に必須。
-- 先に拡張が無いと、Prismaが生成するCREATE TABLE自体が
-- DEFAULT gen_random_uuid() の時点で失敗する。
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
