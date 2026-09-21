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
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "app";

-- CreateEnum
CREATE TYPE "app"."user_status" AS ENUM ('ACTIVE', 'LOCKED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "app"."role_code" AS ENUM ('FIELD', 'OFFICE', 'ADMIN', 'AUDITOR');

-- CreateEnum
CREATE TYPE "app"."record_status" AS ENUM ('DRAFT', 'CONFIRMED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'REVOKED', 'BILLING_LOCKED');

-- CreateEnum
CREATE TYPE "app"."settlement_type" AS ENUM ('QUANTITY', 'TIME');

-- CreateEnum
CREATE TYPE "app"."transport_type" AS ENUM ('ALLOCATED', 'PER_TRIP', 'MONTHLY_FIXED', 'NONE');

-- CreateEnum
CREATE TYPE "app"."billing_status" AS ENUM ('OPEN', 'CALCULATING', 'CALCULATED', 'NEEDS_REVIEW', 'REVIEWED', 'FINALIZED', 'ISSUED', 'SENT', 'VOIDED');

-- CreateEnum
CREATE TYPE "app"."job_status" AS ENUM ('QUEUED', 'PROCESSING', 'GENERATED', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_FINAL');

-- CreateTable
CREATE TABLE "app"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "login_id" VARCHAR(100) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "status" "app"."user_status" NOT NULL DEFAULT 'ACTIVE',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."user_roles" (
    "user_id" UUID NOT NULL,
    "role" "app"."role_code" NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role")
);

-- CreateTable
CREATE TABLE "app"."customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "closing_day" SMALLINT NOT NULL DEFAULT 31,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."customer_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "send_daily" BOOLEAN NOT NULL DEFAULT false,
    "send_invoice" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "customer_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."workers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "workers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."products" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "settlement_type" "app"."settlement_type" NOT NULL,
    "lot_required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."product_contacts" (
    "product_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "purpose" VARCHAR(20) NOT NULL,

    CONSTRAINT "product_contacts_pkey" PRIMARY KEY ("product_id","contact_id","purpose")
);

-- CreateTable
CREATE TABLE "app"."work_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "work_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."defect_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "defect_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."holidays" (
    "holiday_date" DATE NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("holiday_date")
);

-- CreateTable
CREATE TABLE "app"."rate_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "work_type_id" UUID,
    "unit_price" DECIMAL(18,4) NOT NULL,
    "overtime_multiplier" DECIMAL(8,4) NOT NULL DEFAULT 1.25,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,

    CONSTRAINT "rate_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."transport_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "work_type_id" UUID,
    "type" "app"."transport_type" NOT NULL,
    "amount_yen" BIGINT NOT NULL DEFAULT 0,
    "allocation_group" VARCHAR(50),
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,

    CONSTRAINT "transport_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."fixed_charge_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "product_id" UUID NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "amount_yen" BIGINT NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,

    CONSTRAINT "fixed_charge_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."work_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_no" VARCHAR(30) NOT NULL,
    "current_revision_id" UUID,
    "status" "app"."record_status" NOT NULL DEFAULT 'DRAFT',
    "owner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."work_report_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "parent_revision_id" UUID,
    "revision_no" INTEGER NOT NULL,
    "work_date" DATE NOT NULL,
    "reporter_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "work_type_id" UUID NOT NULL,
    "lot_no" VARCHAR(100),
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "break_minutes" INTEGER NOT NULL,
    "regular_minutes" INTEGER NOT NULL,
    "overtime_minutes" INTEGER NOT NULL,
    "regular_person_minutes" INTEGER NOT NULL,
    "overtime_person_minutes" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "work_report_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."work_report_workers" (
    "revision_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,

    CONSTRAINT "work_report_workers_pkey" PRIMARY KEY ("revision_id","worker_id")
);

-- CreateTable
CREATE TABLE "app"."defect_results" (
    "revision_id" UUID NOT NULL,
    "defect_type_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "defect_results_pkey" PRIMARY KEY ("revision_id","defect_type_id")
);

-- CreateTable
CREATE TABLE "app"."delivery_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_no" VARCHAR(30) NOT NULL,
    "current_revision_id" UUID,
    "status" "app"."record_status" NOT NULL DEFAULT 'DRAFT',
    "owner_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."delivery_report_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "report_id" UUID NOT NULL,
    "parent_revision_id" UUID,
    "revision_no" INTEGER NOT NULL,
    "delivery_date" DATE NOT NULL,
    "driver_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "delivery_report_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."delivery_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "delivery_revision_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "allocation_eligible" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "delivery_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" VARCHAR(20) NOT NULL,
    "revision_id" UUID NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "reason" TEXT,
    "actor_id" UUID NOT NULL,
    "acted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."billing_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "status" "app"."billing_status" NOT NULL DEFAULT 'OPEN',
    "calc_version" INTEGER NOT NULL DEFAULT 1,
    "rule_hash" CHAR(64),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."billing_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_run_id" UUID NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_revision_id" UUID,
    "line_type" VARCHAR(30) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "raw_quantity" DECIMAL(18,4),
    "unit" VARCHAR(20),
    "unit_price" DECIMAL(18,4),
    "multiplier" DECIMAL(8,4),
    "unrounded_amount" DECIMAL(18,4) NOT NULL,
    "amount_yen" BIGINT NOT NULL,
    "rule_snapshot" JSONB NOT NULL,
    "calculation" JSONB NOT NULL,

    CONSTRAINT "billing_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."billing_warnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_run_id" UUID NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "source_type" VARCHAR(30),
    "source_revision_id" UUID,
    "message" VARCHAR(500) NOT NULL,
    "resolution" VARCHAR(30),
    "reason" TEXT,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "billing_warnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invoices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "billing_run_id" UUID NOT NULL,
    "invoice_no" VARCHAR(30) NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "app"."billing_status" NOT NULL,
    "customer_snapshot" JSONB NOT NULL,
    "subtotal_yen" BIGINT NOT NULL,
    "tax_yen" BIGINT NOT NULL,
    "total_yen" BIGINT NOT NULL,
    "tax_rate" DECIMAL(8,4) NOT NULL DEFAULT 0.10,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."invoice_recipients" (
    "invoice_id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "recipient_type" VARCHAR(10) NOT NULL,
    "contact_snapshot" JSONB NOT NULL,

    CONSTRAINT "invoice_recipients_pkey" PRIMARY KEY ("invoice_id","email","recipient_type")
);

-- CreateTable
CREATE TABLE "app"."files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storage_key" TEXT NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "classification" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."template_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_type" VARCHAR(40) NOT NULL,
    "version" VARCHAR(30) NOT NULL,
    "provider_template_id" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."document_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_type" VARCHAR(30) NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_id" UUID NOT NULL,
    "template_version" VARCHAR(30) NOT NULL,
    "status" "app"."job_status" NOT NULL DEFAULT 'QUEUED',
    "idempotency_key" VARCHAR(300) NOT NULL,
    "file_id" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."mail_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_job_id" UUID NOT NULL,
    "recipients" JSONB NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "app"."job_status" NOT NULL DEFAULT 'QUEUED',
    "send_revision" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(300) NOT NULL,
    "provider_message_id" VARCHAR(300),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(50) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."processed_events" (
    "consumer" VARCHAR(100) NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer","event_id")
);

-- CreateTable
CREATE TABLE "app"."idempotency_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID NOT NULL,
    "route" VARCHAR(200) NOT NULL,
    "idempotency_key" VARCHAR(100) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "status" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app"."audit_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" UUID NOT NULL,
    "before_data" JSONB,
    "after_data" JSONB,
    "reason" TEXT,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_login_id_key" ON "app"."users"("login_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "app"."customers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "customer_contacts_customer_id_code_key" ON "app"."customer_contacts"("customer_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "workers_code_key" ON "app"."workers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "products_customer_id_code_key" ON "app"."products"("customer_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "work_types_product_id_code_key" ON "app"."work_types"("product_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "defect_types_product_id_code_key" ON "app"."defect_types"("product_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "work_reports_report_no_key" ON "app"."work_reports"("report_no");

-- CreateIndex
CREATE INDEX "report_status" ON "app"."work_reports"("status", "updated_at");

-- CreateIndex
CREATE INDEX "work_revision_search" ON "app"."work_report_revisions"("work_date", "customer_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_report_revisions_report_id_revision_no_key" ON "app"."work_report_revisions"("report_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_reports_report_no_key" ON "app"."delivery_reports"("report_no");

-- CreateIndex
CREATE INDEX "delivery_status" ON "app"."delivery_reports"("status", "updated_at");

-- CreateIndex
CREATE INDEX "delivery_revision_search" ON "app"."delivery_report_revisions"("delivery_date", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_report_revisions_report_id_revision_no_key" ON "app"."delivery_report_revisions"("report_id", "revision_no");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_items_delivery_revision_id_product_id_key" ON "app"."delivery_items"("delivery_revision_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_runs_customer_id_period_start_period_end_calc_versi_key" ON "app"."billing_runs"("customer_id", "period_start", "period_end", "calc_version");

-- CreateIndex
CREATE INDEX "billing_warning_open" ON "app"."billing_warnings"("billing_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_revision_key" ON "app"."invoices"("invoice_no", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "files_storage_key_key" ON "app"."files"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "template_versions_template_type_version_key" ON "app"."template_versions"("template_type", "version");

-- CreateIndex
CREATE UNIQUE INDEX "document_jobs_idempotency_key_key" ON "app"."document_jobs"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "mail_jobs_idempotency_key_key" ON "app"."mail_jobs"("idempotency_key");

-- CreateIndex
CREATE INDEX "outbox_ready" ON "app"."outbox_events"("status", "available_at");

-- CreateIndex
CREATE INDEX "idempotency_expiry" ON "app"."idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_actor_id_route_idempotency_key_key" ON "app"."idempotency_records"("actor_id", "route", "idempotency_key");

-- CreateIndex
CREATE INDEX "audit_target" ON "app"."audit_events"("target_type", "target_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "app"."user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."products" ADD CONSTRAINT "products_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."product_contacts" ADD CONSTRAINT "product_contacts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."product_contacts" ADD CONSTRAINT "product_contacts_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "app"."customer_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_types" ADD CONSTRAINT "work_types_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."defect_types" ADD CONSTRAINT "defect_types_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."rate_rules" ADD CONSTRAINT "rate_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."rate_rules" ADD CONSTRAINT "rate_rules_work_type_id_fkey" FOREIGN KEY ("work_type_id") REFERENCES "app"."work_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."transport_rules" ADD CONSTRAINT "transport_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."transport_rules" ADD CONSTRAINT "transport_rules_work_type_id_fkey" FOREIGN KEY ("work_type_id") REFERENCES "app"."work_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."fixed_charge_rules" ADD CONSTRAINT "fixed_charge_rules_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_reports" ADD CONSTRAINT "work_reports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "app"."work_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "app"."work_report_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_revisions" ADD CONSTRAINT "work_report_revisions_work_type_id_fkey" FOREIGN KEY ("work_type_id") REFERENCES "app"."work_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_workers" ADD CONSTRAINT "work_report_workers_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "app"."work_report_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."work_report_workers" ADD CONSTRAINT "work_report_workers_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "app"."workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."defect_results" ADD CONSTRAINT "defect_results_revision_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "app"."work_report_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."defect_results" ADD CONSTRAINT "defect_results_defect_type_id_fkey" FOREIGN KEY ("defect_type_id") REFERENCES "app"."defect_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_reports" ADD CONSTRAINT "delivery_reports_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_report_revisions" ADD CONSTRAINT "delivery_report_revisions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "app"."delivery_reports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_report_revisions" ADD CONSTRAINT "delivery_report_revisions_parent_revision_id_fkey" FOREIGN KEY ("parent_revision_id") REFERENCES "app"."delivery_report_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_report_revisions" ADD CONSTRAINT "delivery_report_revisions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "app"."workers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_report_revisions" ADD CONSTRAINT "delivery_report_revisions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_items" ADD CONSTRAINT "delivery_items_delivery_revision_id_fkey" FOREIGN KEY ("delivery_revision_id") REFERENCES "app"."delivery_report_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."delivery_items" ADD CONSTRAINT "delivery_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "app"."products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."approvals" ADD CONSTRAINT "approvals_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."billing_runs" ADD CONSTRAINT "billing_runs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "app"."customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."billing_lines" ADD CONSTRAINT "billing_lines_billing_run_id_fkey" FOREIGN KEY ("billing_run_id") REFERENCES "app"."billing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."billing_warnings" ADD CONSTRAINT "billing_warnings_billing_run_id_fkey" FOREIGN KEY ("billing_run_id") REFERENCES "app"."billing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."billing_warnings" ADD CONSTRAINT "billing_warnings_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "app"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invoices" ADD CONSTRAINT "invoices_billing_run_id_fkey" FOREIGN KEY ("billing_run_id") REFERENCES "app"."billing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."invoice_recipients" ADD CONSTRAINT "invoice_recipients_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "app"."invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."document_jobs" ADD CONSTRAINT "document_jobs_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "app"."files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."mail_jobs" ADD CONSTRAINT "mail_jobs_document_job_id_fkey" FOREIGN KEY ("document_job_id") REFERENCES "app"."document_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app"."audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "app"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
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
