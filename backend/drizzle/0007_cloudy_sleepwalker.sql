CREATE TABLE "mfp_barcode_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfp_barcode_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"barcode" text NOT NULL,
	"mfp_url" text NOT NULL,
	"mfp_status" integer NOT NULL,
	"result_code" integer,
	"response_body" "bytea",
	"response_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mfp_barcode_responses_barcode_created_at_idx" ON "mfp_barcode_responses" USING btree ("barcode","created_at");