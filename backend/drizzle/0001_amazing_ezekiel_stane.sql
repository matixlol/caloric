CREATE TABLE "anmat_product_derived_data" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "anmat_product_derived_data_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"html_blob_id" bigint NOT NULL,
	"nutrition_found" boolean NOT NULL,
	"serving_text" text,
	"serving_quantity" integer,
	"serving_unit" text,
	"calories" integer,
	"protein_grams" text,
	"carbs_grams" text,
	"fat_grams" text,
	"fiber_grams" text,
	"sugars_grams" text,
	"sodium_mg" integer,
	"ean_attempted" boolean DEFAULT true NOT NULL,
	"ean_status" text DEFAULT 'html_parsed' NOT NULL,
	"ean" text,
	"ean_source" text,
	"ean_candidates" jsonb,
	"parsed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "anmat_product_html_blobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "anmat_product_html_blobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_path" text NOT NULL,
	"ingest_source" text DEFAULT 'disk_import' NOT NULL,
	"run_key" text NOT NULL,
	"detail_key" text,
	"token" text,
	"query" text,
	"query_index" integer,
	"page" integer,
	"wrapper_url" text,
	"content_url" text,
	"search_mode" text,
	"province" text,
	"rnpa" text,
	"denominacion" text,
	"nombre_fantasia" text,
	"marca" text,
	"titular" text,
	"estado" text,
	"compression_algo" text NOT NULL,
	"html_zstd" "bytea" NOT NULL,
	"html_sha256" text NOT NULL,
	"uncompressed_bytes" integer NOT NULL,
	"compressed_bytes" integer NOT NULL,
	"saved_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfp_auth_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfp_auth_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"storage_state" jsonb,
	"session_storage" jsonb,
	"authorization" text,
	"cookie_header" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "anmat_product_derived_data" ADD CONSTRAINT "anmat_product_derived_data_html_blob_id_anmat_product_html_blobs_id_fk" FOREIGN KEY ("html_blob_id") REFERENCES "public"."anmat_product_html_blobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "anmat_product_derived_data_html_blob_uidx" ON "anmat_product_derived_data" USING btree ("html_blob_id");--> statement-breakpoint
CREATE INDEX "anmat_product_derived_data_nutrition_found_idx" ON "anmat_product_derived_data" USING btree ("nutrition_found");--> statement-breakpoint
CREATE INDEX "anmat_product_derived_data_ean_status_idx" ON "anmat_product_derived_data" USING btree ("ean_status");--> statement-breakpoint
CREATE INDEX "anmat_product_derived_data_ean_idx" ON "anmat_product_derived_data" USING btree ("ean");--> statement-breakpoint
CREATE UNIQUE INDEX "anmat_product_html_blobs_source_path_uidx" ON "anmat_product_html_blobs" USING btree ("source_path");--> statement-breakpoint
CREATE INDEX "anmat_product_html_blobs_ingest_source_idx" ON "anmat_product_html_blobs" USING btree ("ingest_source");--> statement-breakpoint
CREATE INDEX "anmat_product_html_blobs_detail_key_idx" ON "anmat_product_html_blobs" USING btree ("detail_key");--> statement-breakpoint
CREATE INDEX "anmat_product_html_blobs_rnpa_idx" ON "anmat_product_html_blobs" USING btree ("rnpa");--> statement-breakpoint
CREATE INDEX "anmat_product_html_blobs_marca_idx" ON "anmat_product_html_blobs" USING btree ("marca");--> statement-breakpoint
CREATE INDEX "anmat_product_html_blobs_denominacion_idx" ON "anmat_product_html_blobs" USING btree ("denominacion");--> statement-breakpoint
CREATE UNIQUE INDEX "mfp_auth_sessions_provider_uidx" ON "mfp_auth_sessions" USING btree ("provider");