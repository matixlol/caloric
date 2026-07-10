CREATE TABLE "user_recipes" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_recipes_pk" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE INDEX "user_recipes_user_updated_at_idx" ON "user_recipes" USING btree ("user_id","updated_at");