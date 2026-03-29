CREATE TABLE "open_food_facts_search_responses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "open_food_facts_search_responses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"query" text NOT NULL,
	"page" integer NOT NULL,
	"page_size" integer NOT NULL,
	"off_url" text NOT NULL,
	"off_status" integer NOT NULL,
	"response_json" jsonb,
	"response_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "open_food_facts_search_responses_query_created_at_idx" ON "open_food_facts_search_responses" USING btree ("query","created_at");