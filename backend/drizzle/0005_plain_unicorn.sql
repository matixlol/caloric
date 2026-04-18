CREATE TABLE "ai_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation" jsonb NOT NULL,
	"search_result_counter" integer DEFAULT 1 NOT NULL,
	"search_results_by_local_id" jsonb NOT NULL,
	"pending_approvals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ai_sessions_user_updated_at_idx" ON "ai_sessions" USING btree ("user_id","updated_at");