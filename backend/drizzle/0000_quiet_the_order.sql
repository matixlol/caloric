CREATE TABLE "mfp_food_detail_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfp_food_detail_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"search_response_id" bigint NOT NULL,
	"food_id" text NOT NULL,
	"version" text NOT NULL,
	"mfp_url" text NOT NULL,
	"mfp_status" integer NOT NULL,
	"response_json" jsonb,
	"response_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mfp_search_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mfp_search_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"query" text NOT NULL,
	"offset" integer NOT NULL,
	"max_items" integer NOT NULL,
	"country_code" text NOT NULL,
	"resource_type" text NOT NULL,
	"mfp_url" text NOT NULL,
	"mfp_status" integer NOT NULL,
	"response_json" jsonb,
	"response_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mfp_food_detail_responses" ADD CONSTRAINT "mfp_food_detail_responses_search_response_id_mfp_search_responses_id_fk" FOREIGN KEY ("search_response_id") REFERENCES "public"."mfp_search_responses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mfp_food_detail_responses_search_response_id_idx" ON "mfp_food_detail_responses" USING btree ("search_response_id");--> statement-breakpoint
CREATE INDEX "mfp_food_detail_responses_food_version_idx" ON "mfp_food_detail_responses" USING btree ("food_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mfp_food_detail_responses_search_food_version_uidx" ON "mfp_food_detail_responses" USING btree ("search_response_id","food_id","version");--> statement-breakpoint
CREATE INDEX "mfp_search_responses_query_created_at_idx" ON "mfp_search_responses" USING btree ("query","created_at");