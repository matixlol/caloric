CREATE TABLE "friendships" (
	"id" text PRIMARY KEY NOT NULL,
	"requester_user_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"user_a_id" text NOT NULL,
	"user_b_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"friend_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_requester_user_id_social_profiles_user_id_fk" FOREIGN KEY ("requester_user_id") REFERENCES "public"."social_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_recipient_user_id_social_profiles_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."social_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_a_id_social_profiles_user_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."social_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_b_id_social_profiles_user_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."social_profiles"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "friendships_pair_uidx" ON "friendships" USING btree ("user_a_id","user_b_id");--> statement-breakpoint
CREATE INDEX "friendships_requester_idx" ON "friendships" USING btree ("requester_user_id");--> statement-breakpoint
CREATE INDEX "friendships_recipient_idx" ON "friendships" USING btree ("recipient_user_id");--> statement-breakpoint
CREATE INDEX "friendships_user_a_status_idx" ON "friendships" USING btree ("user_a_id","status");--> statement-breakpoint
CREATE INDEX "friendships_user_b_status_idx" ON "friendships" USING btree ("user_b_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "social_profiles_friend_code_uidx" ON "social_profiles" USING btree ("friend_code");