CREATE TYPE "public"."card_kind" AS ENUM('object', 'decision', 'preference', 'fact', 'faq', 'case', 'viewpoint');--> statement-breakpoint
CREATE TYPE "public"."card_origin" AS ENUM('intake', 'distill', 'manual', 'scout');--> statement-breakpoint
CREATE TYPE "public"."card_status" AS ENUM('pending', 'confirmed', 'dropped');--> statement-breakpoint
CREATE TYPE "public"."doc_status" AS ENUM('parsed', 'needs_ocr', 'failed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."file_decision" AS ENUM('pending', 'rule_keep', 'rule_skip', 'model_keep', 'model_skip', 'ask', 'error');--> statement-breakpoint
CREATE TYPE "public"."gap_status" AS ENUM('open', 'answered', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ingest_kind" AS ENUM('upload', 'scout', 'manual');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('draft', 'running', 'done', 'failed', 'revoked');--> statement-breakpoint
CREATE TABLE "ai_employee_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ai_employee_id" uuid NOT NULL,
	"department_id" uuid,
	"user_id" uuid,
	"capability" text DEFAULT 'use' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_employee_grants_target_shape" CHECK ((department_id is not null and user_id is null) or (department_id is null and user_id is not null))
);
--> statement-breakpoint
CREATE TABLE "ai_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"title" text,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"kind" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"page_no" integer,
	"paragraph_no" integer,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"asset_id" uuid,
	"ingest_run_id" uuid,
	"title" text NOT NULL,
	"mime" text NOT NULL,
	"page_count" integer,
	"char_count" integer DEFAULT 0 NOT NULL,
	"lang" text DEFAULT 'zh',
	"status" "doc_status" DEFAULT 'parsed' NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"asset_id" uuid,
	"source_path" text NOT NULL,
	"decision" "file_decision" DEFAULT 'pending' NOT NULL,
	"reason" text,
	"error" text,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"kind" "ingest_kind" NOT NULL,
	"goal" text,
	"status" "ingest_status" DEFAULT 'draft' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "card_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"chunk_id" uuid,
	"document_id" uuid,
	"page_no" integer,
	"locator" text,
	"quote" text NOT NULL,
	"char_start" integer,
	"char_end" integer,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"kind" "card_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "card_status" DEFAULT 'pending' NOT NULL,
	"origin" "card_origin" NOT NULL,
	"product" text,
	"category" text,
	"visibility" text DEFAULT 'shared' NOT NULL,
	"external_ok" boolean DEFAULT false NOT NULL,
	"valid_until" date,
	"rev" integer DEFAULT 1 NOT NULL,
	"human_edited" boolean DEFAULT false NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"conflict_with" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"ingest_run_id" uuid,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"question" text NOT NULL,
	"status" "gap_status" DEFAULT 'open' NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"cited_card_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"invalid_cites" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"unverified_numbers" text[] DEFAULT '{}'::text[] NOT NULL,
	"gap_id" uuid,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regression_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"hit_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"retained" numeric(5, 4) NOT NULL,
	"pass" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regression_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"q" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"baseline_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regression_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"build_tag" text NOT NULL,
	"total" integer NOT NULL,
	"passed" integer NOT NULL,
	"retained" numeric(5, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_employee_grants" ADD CONSTRAINT "ai_employee_grants_ai_employee_id_ai_employees_id_fk" FOREIGN KEY ("ai_employee_id") REFERENCES "public"."ai_employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee_grants" ADD CONSTRAINT "ai_employee_grants_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee_grants" ADD CONSTRAINT "ai_employee_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employee_grants" ADD CONSTRAINT "ai_employee_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_employees" ADD CONSTRAINT "ai_employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD CONSTRAINT "doc_chunks_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_chunks" ADD CONSTRAINT "doc_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_files" ADD CONSTRAINT "ingest_files_run_id_ingest_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_files" ADD CONSTRAINT "ingest_files_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_evidence" ADD CONSTRAINT "card_evidence_card_id_knowledge_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."knowledge_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_evidence" ADD CONSTRAINT "card_evidence_chunk_id_doc_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."doc_chunks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_evidence" ADD CONSTRAINT "card_evidence_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_cards" ADD CONSTRAINT "knowledge_cards_ingest_run_id_ingest_runs_id_fk" FOREIGN KEY ("ingest_run_id") REFERENCES "public"."ingest_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_gaps" ADD CONSTRAINT "knowledge_gaps_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_logs" ADD CONSTRAINT "qa_logs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_logs" ADD CONSTRAINT "qa_logs_gap_id_knowledge_gaps_id_fk" FOREIGN KEY ("gap_id") REFERENCES "public"."knowledge_gaps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_items" ADD CONSTRAINT "regression_items_run_id_regression_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."regression_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_items" ADD CONSTRAINT "regression_items_question_id_regression_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."regression_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_questions" ADD CONSTRAINT "regression_questions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regression_runs" ADD CONSTRAINT "regression_runs_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_employee_grants_department_unique" ON "ai_employee_grants" USING btree ("ai_employee_id","department_id") WHERE department_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_employee_grants_user_unique" ON "ai_employee_grants" USING btree ("ai_employee_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "ai_employee_grants_department_idx" ON "ai_employee_grants" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "ai_employee_grants_user_idx" ON "ai_employee_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_employees_tenant_slug_unique" ON "ai_employees" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_sha_department_unique" ON "assets" USING btree ("tenant_id","sha256","department_id");--> statement-breakpoint
CREATE INDEX "assets_department_kind_idx" ON "assets" USING btree ("department_id","kind");--> statement-breakpoint
CREATE INDEX "assets_created_by_idx" ON "assets" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_chunks_document_ord_unique" ON "doc_chunks" USING btree ("document_id","ord");--> statement-breakpoint
CREATE INDEX "doc_chunks_document_idx" ON "doc_chunks" USING btree ("document_id","ord");--> statement-breakpoint
CREATE INDEX "doc_chunks_department_idx" ON "doc_chunks" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "doc_chunks_embedding_hnsw_idx" ON "doc_chunks" USING hnsw ("embedding" vector_cosine_ops) WHERE embedding is not null;--> statement-breakpoint
CREATE INDEX "documents_department_status_idx" ON "documents" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "documents_ingest_run_idx" ON "documents" USING btree ("ingest_run_id");--> statement-breakpoint
CREATE INDEX "ingest_files_run_decision_idx" ON "ingest_files" USING btree ("run_id","decision");--> statement-breakpoint
CREATE INDEX "ingest_runs_department_status_idx" ON "ingest_runs" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "ingest_runs_created_by_idx" ON "ingest_runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "card_evidence_card_verified_idx" ON "card_evidence" USING btree ("card_id","verified");--> statement-breakpoint
CREATE UNIQUE INDEX "card_evidence_location_unique" ON "card_evidence" USING btree ("card_id","document_id","char_start","char_end");--> statement-breakpoint
CREATE INDEX "knowledge_cards_department_status_idx" ON "knowledge_cards" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "knowledge_cards_ingest_run_idx" ON "knowledge_cards" USING btree ("ingest_run_id");--> statement-breakpoint
CREATE INDEX "knowledge_cards_extra_gin_idx" ON "knowledge_cards" USING gin ("extra");--> statement-breakpoint
CREATE INDEX "knowledge_gaps_department_status_idx" ON "knowledge_gaps" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "qa_logs_department_created_idx" ON "qa_logs" USING btree ("department_id","created_at");--> statement-breakpoint
CREATE INDEX "regression_items_run_idx" ON "regression_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "regression_questions_department_idx" ON "regression_questions" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "regression_runs_department_created_idx" ON "regression_runs" USING btree ("department_id","created_at");