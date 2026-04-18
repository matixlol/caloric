CREATE TABLE "user_food_entries" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_food_entries_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_food_entries_user_updated_at_idx" ON "user_food_entries" USING btree ("user_id","updated_at");