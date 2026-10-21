CREATE TABLE `ai_sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`conversation` text NOT NULL,
	`search_result_counter` integer DEFAULT 1 NOT NULL,
	`search_results_by_local_id` text NOT NULL,
	`pending_approvals` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `anmat_live_search_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`query` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `anmat_product_derived_data` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`product_id` integer NOT NULL,
	`nutrition_found` integer NOT NULL,
	`serving_text` text,
	`serving_quantity` integer,
	`serving_unit` text,
	`calories` integer,
	`protein_grams` text,
	`carbs_grams` text,
	`fat_grams` text,
	`fiber_grams` text,
	`sugars_grams` text,
	`sodium_mg` integer,
	`ean_attempted` integer DEFAULT true NOT NULL,
	`ean_status` text DEFAULT 'html_parsed' NOT NULL,
	`ean` text,
	`ean_source` text,
	`ean_candidates` text,
	`parsed_at` integer NOT NULL,
	CONSTRAINT `fk_anmat_product_derived_data_product_id_anmat_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `anmat_products`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `anmat_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_path` text NOT NULL,
	`ingest_source` text DEFAULT 'disk_import' NOT NULL,
	`run_key` text NOT NULL,
	`detail_key` text,
	`token` text,
	`query` text,
	`query_index` integer,
	`page` integer,
	`wrapper_url` text,
	`content_url` text,
	`search_mode` text,
	`province` text,
	`rnpa` text,
	`denominacion` text,
	`nombre_fantasia` text,
	`marca` text,
	`titular` text,
	`estado` text,
	`html_key` text,
	`html_sha256` text NOT NULL,
	`saved_at` integer,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` text PRIMARY KEY,
	`requester_user_id` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`user_a_id` text NOT NULL,
	`user_b_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_friendships_requester_user_id_social_profiles_user_id_fk` FOREIGN KEY (`requester_user_id`) REFERENCES `social_profiles`(`user_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_friendships_recipient_user_id_social_profiles_user_id_fk` FOREIGN KEY (`recipient_user_id`) REFERENCES `social_profiles`(`user_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_friendships_user_a_id_social_profiles_user_id_fk` FOREIGN KEY (`user_a_id`) REFERENCES `social_profiles`(`user_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_friendships_user_b_id_social_profiles_user_id_fk` FOREIGN KEY (`user_b_id`) REFERENCES `social_profiles`(`user_id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mfp_auth_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`provider` text NOT NULL,
	`storage_state` text,
	`session_storage` text,
	`authorization` text,
	`cookie_header` text,
	`refreshed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mfp_barcode_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`barcode` text NOT NULL,
	`mfp_url` text NOT NULL,
	`mfp_status` integer NOT NULL,
	`result_code` integer,
	`response_body` blob,
	`response_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mfp_food_detail_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`search_response_id` integer NOT NULL,
	`food_id` text NOT NULL,
	`version` text NOT NULL,
	`mfp_url` text NOT NULL,
	`mfp_status` integer NOT NULL,
	`response_json` text,
	`response_text` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_mfp_food_detail_responses_search_response_id_mfp_search_responses_id_fk` FOREIGN KEY (`search_response_id`) REFERENCES `mfp_search_responses`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `mfp_search_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`query` text NOT NULL,
	`offset` integer NOT NULL,
	`max_items` integer NOT NULL,
	`country_code` text NOT NULL,
	`resource_type` text NOT NULL,
	`mfp_url` text NOT NULL,
	`mfp_status` integer NOT NULL,
	`response_json` text,
	`response_text` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `open_food_facts_search_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`query` text NOT NULL,
	`page` integer NOT NULL,
	`page_size` integer NOT NULL,
	`off_url` text NOT NULL,
	`off_status` integer NOT NULL,
	`response_json` text,
	`response_text` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `social_profiles` (
	`user_id` text PRIMARY KEY,
	`display_name` text NOT NULL,
	`friend_code` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_food_entries` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `user_food_entries_pk` PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `user_recipes` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT `user_recipes_pk` PRIMARY KEY(`user_id`, `id`)
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_sessions_user_updated_at_idx` ON `ai_sessions` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `anmat_live_search_requests_query_created_at_idx` ON `anmat_live_search_requests` (`query`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `anmat_product_derived_data_product_uidx` ON `anmat_product_derived_data` (`product_id`);--> statement-breakpoint
CREATE INDEX `anmat_product_derived_data_nutrition_found_idx` ON `anmat_product_derived_data` (`nutrition_found`);--> statement-breakpoint
CREATE INDEX `anmat_product_derived_data_ean_status_idx` ON `anmat_product_derived_data` (`ean_status`);--> statement-breakpoint
CREATE INDEX `anmat_product_derived_data_ean_idx` ON `anmat_product_derived_data` (`ean`);--> statement-breakpoint
CREATE UNIQUE INDEX `anmat_products_source_path_uidx` ON `anmat_products` (`source_path`);--> statement-breakpoint
CREATE INDEX `anmat_products_ingest_source_idx` ON `anmat_products` (`ingest_source`);--> statement-breakpoint
CREATE INDEX `anmat_products_detail_key_idx` ON `anmat_products` (`detail_key`);--> statement-breakpoint
CREATE INDEX `anmat_products_rnpa_idx` ON `anmat_products` (`rnpa`);--> statement-breakpoint
CREATE INDEX `anmat_products_marca_idx` ON `anmat_products` (`marca`);--> statement-breakpoint
CREATE INDEX `anmat_products_denominacion_idx` ON `anmat_products` (`denominacion`);--> statement-breakpoint
CREATE UNIQUE INDEX `friendships_pair_uidx` ON `friendships` (`user_a_id`,`user_b_id`);--> statement-breakpoint
CREATE INDEX `friendships_requester_idx` ON `friendships` (`requester_user_id`);--> statement-breakpoint
CREATE INDEX `friendships_recipient_idx` ON `friendships` (`recipient_user_id`);--> statement-breakpoint
CREATE INDEX `friendships_user_a_status_idx` ON `friendships` (`user_a_id`,`status`);--> statement-breakpoint
CREATE INDEX `friendships_user_b_status_idx` ON `friendships` (`user_b_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `mfp_auth_sessions_provider_uidx` ON `mfp_auth_sessions` (`provider`);--> statement-breakpoint
CREATE INDEX `mfp_barcode_responses_barcode_created_at_idx` ON `mfp_barcode_responses` (`barcode`,`created_at`);--> statement-breakpoint
CREATE INDEX `mfp_food_detail_responses_search_response_id_idx` ON `mfp_food_detail_responses` (`search_response_id`);--> statement-breakpoint
CREATE INDEX `mfp_food_detail_responses_food_version_idx` ON `mfp_food_detail_responses` (`food_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `mfp_food_detail_responses_search_food_version_uidx` ON `mfp_food_detail_responses` (`search_response_id`,`food_id`,`version`);--> statement-breakpoint
CREATE INDEX `mfp_search_responses_query_created_at_idx` ON `mfp_search_responses` (`query`,`created_at`);--> statement-breakpoint
CREATE INDEX `open_food_facts_search_responses_query_created_at_idx` ON `open_food_facts_search_responses` (`query`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `social_profiles_friend_code_uidx` ON `social_profiles` (`friend_code`);--> statement-breakpoint
CREATE INDEX `user_food_entries_user_updated_at_idx` ON `user_food_entries` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `user_recipes_user_updated_at_idx` ON `user_recipes` (`user_id`,`updated_at`);