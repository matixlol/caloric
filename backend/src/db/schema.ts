import type { FoodEntry, UserSettings } from "@caloric/data-model";
import { bigint, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array | Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const mfpAuthSessions = pgTable(
  "mfp_auth_sessions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    provider: text("provider").notNull(),
    storageState: jsonb("storage_state"),
    sessionStorage: jsonb("session_storage"),
    authorization: text("authorization"),
    cookieHeader: text("cookie_header"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerUnique: uniqueIndex("mfp_auth_sessions_provider_uidx").on(table.provider),
  }),
);

export const mfpSearchResponses = pgTable(
  "mfp_search_responses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    query: text("query").notNull(),
    offset: integer("offset").notNull(),
    maxItems: integer("max_items").notNull(),
    countryCode: text("country_code").notNull(),
    resourceType: text("resource_type").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    responseJson: jsonb("response_json"),
    responseText: text("response_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    queryCreatedAtIdx: index("mfp_search_responses_query_created_at_idx").on(table.query, table.createdAt),
  }),
);

export const mfpFoodDetailResponses = pgTable(
  "mfp_food_detail_responses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    searchResponseId: bigint("search_response_id", { mode: "number" })
      .references(() => mfpSearchResponses.id, { onDelete: "cascade" })
      .notNull(),
    foodId: text("food_id").notNull(),
    version: text("version").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    responseJson: jsonb("response_json"),
    responseText: text("response_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    searchResponseIdIdx: index("mfp_food_detail_responses_search_response_id_idx").on(table.searchResponseId),
    foodVersionIdx: index("mfp_food_detail_responses_food_version_idx").on(table.foodId, table.version),
    searchFoodVersionUnique: uniqueIndex("mfp_food_detail_responses_search_food_version_uidx").on(
      table.searchResponseId,
      table.foodId,
      table.version,
    ),
  }),
);

export const mfpBarcodeResponses = pgTable(
  "mfp_barcode_responses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    barcode: text("barcode").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    resultCode: integer("result_code"),
    responseBody: bytea("response_body"),
    responseJson: jsonb("response_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    barcodeCreatedAtIdx: index("mfp_barcode_responses_barcode_created_at_idx").on(
      table.barcode,
      table.createdAt,
    ),
  }),
);

export const openFoodFactsSearchResponses = pgTable(
  "open_food_facts_search_responses",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    query: text("query").notNull(),
    page: integer("page").notNull(),
    pageSize: integer("page_size").notNull(),
    offUrl: text("off_url").notNull(),
    offStatus: integer("off_status").notNull(),
    responseJson: jsonb("response_json"),
    responseText: text("response_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    queryCreatedAtIdx: index("open_food_facts_search_responses_query_created_at_idx").on(table.query, table.createdAt),
  }),
);

export const anmatLiveSearchRequests = pgTable(
  "anmat_live_search_requests",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    query: text("query").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    queryCreatedAtIdx: index("anmat_live_search_requests_query_created_at_idx").on(table.query, table.createdAt),
  }),
);

export const anmatProductHtmlBlobs = pgTable(
  "anmat_product_html_blobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourcePath: text("source_path").notNull(),
    ingestSource: text("ingest_source").notNull().default("disk_import"),
    runKey: text("run_key").notNull(),
    detailKey: text("detail_key"),
    token: text("token"),
    query: text("query"),
    queryIndex: integer("query_index"),
    page: integer("page"),
    wrapperUrl: text("wrapper_url"),
    contentUrl: text("content_url"),
    searchMode: text("search_mode"),
    province: text("province"),
    rnpa: text("rnpa"),
    denominacion: text("denominacion"),
    nombreFantasia: text("nombre_fantasia"),
    marca: text("marca"),
    titular: text("titular"),
    estado: text("estado"),
    compressionAlgo: text("compression_algo").notNull(),
    htmlZstd: bytea("html_zstd").notNull(),
    htmlSha256: text("html_sha256").notNull(),
    uncompressedBytes: integer("uncompressed_bytes").notNull(),
    compressedBytes: integer("compressed_bytes").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }),
    importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourcePathUnique: uniqueIndex("anmat_product_html_blobs_source_path_uidx").on(table.sourcePath),
    ingestSourceIdx: index("anmat_product_html_blobs_ingest_source_idx").on(table.ingestSource),
    detailKeyIdx: index("anmat_product_html_blobs_detail_key_idx").on(table.detailKey),
    rnpaIdx: index("anmat_product_html_blobs_rnpa_idx").on(table.rnpa),
    brandIdx: index("anmat_product_html_blobs_marca_idx").on(table.marca),
    nameIdx: index("anmat_product_html_blobs_denominacion_idx").on(table.denominacion),
  }),
);

export const anmatProductDerivedData = pgTable(
  "anmat_product_derived_data",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    htmlBlobId: bigint("html_blob_id", { mode: "number" })
      .references(() => anmatProductHtmlBlobs.id, { onDelete: "cascade" })
      .notNull(),
    nutritionFound: boolean("nutrition_found").notNull(),
    servingText: text("serving_text"),
    servingQuantity: integer("serving_quantity"),
    servingUnit: text("serving_unit"),
    calories: integer("calories"),
    proteinGrams: text("protein_grams"),
    carbsGrams: text("carbs_grams"),
    fatGrams: text("fat_grams"),
    fiberGrams: text("fiber_grams"),
    sugarsGrams: text("sugars_grams"),
    sodiumMg: integer("sodium_mg"),
    eanAttempted: boolean("ean_attempted").notNull().default(true),
    eanStatus: text("ean_status").notNull().default("html_parsed"),
    ean: text("ean"),
    eanSource: text("ean_source"),
    eanCandidates: jsonb("ean_candidates"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    htmlBlobUnique: uniqueIndex("anmat_product_derived_data_html_blob_uidx").on(table.htmlBlobId),
    nutritionFoundIdx: index("anmat_product_derived_data_nutrition_found_idx").on(table.nutritionFound),
    eanStatusIdx: index("anmat_product_derived_data_ean_status_idx").on(table.eanStatus),
    eanIdx: index("anmat_product_derived_data_ean_idx").on(table.ean),
  }),
);

// --- Better Auth core tables ---------------------------------------------
// These match the schema Better Auth's Drizzle adapter expects. The JS
// property names (camelCase) are the field names Better Auth reads/writes;
// the SQL column names are snake_case to match the rest of this schema.
// Existing users are migrated by seeding `user`/`account` with the same ids
// the app already uses (formerly Clerk user ids), so all user-scoped data
// below continues to resolve without any rewrite.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("session_user_id_idx").on(table.userId),
  }),
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdIdx: index("account_user_id_idx").on(table.userId),
  }),
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    identifierIdx: index("verification_identifier_idx").on(table.identifier),
  }),
);

export const userFoodEntries = pgTable(
  "user_food_entries",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    data: jsonb("data").$type<FoodEntry>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.id], name: "user_food_entries_pk" }),
    userUpdatedAtIdx: index("user_food_entries_user_updated_at_idx").on(table.userId, table.updatedAt),
  }),
);

export const userSettings = pgTable(
  "user_settings",
  {
    userId: text("user_id").primaryKey(),
    data: jsonb("data").$type<UserSettings>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
);

const timestampNow = (name: string) => timestamp(name, { withTimezone: true }).defaultNow().notNull();

export const socialProfiles = pgTable(
  "social_profiles",
  {
    userId: text("user_id").primaryKey(),
    displayName: text("display_name").notNull(),
    friendCode: text("friend_code").notNull(),
    createdAt: timestampNow("created_at"),
    updatedAt: timestampNow("updated_at"),
  },
  (table) => ({
    friendCodeUnique: uniqueIndex("social_profiles_friend_code_uidx").on(table.friendCode),
  }),
);

const socialProfileRef = (name: string) =>
  text(name)
    .notNull()
    .references(() => socialProfiles.userId, { onDelete: "cascade" });

export const friendships = pgTable(
  "friendships",
  {
    id: text("id").primaryKey(),
    requesterUserId: socialProfileRef("requester_user_id"),
    recipientUserId: socialProfileRef("recipient_user_id"),
    userAId: socialProfileRef("user_a_id"),
    userBId: socialProfileRef("user_b_id"),
    status: text("status").notNull(),
    createdAt: timestampNow("created_at"),
    updatedAt: timestampNow("updated_at"),
  },
  (table) => ({
    pairUnique: uniqueIndex("friendships_pair_uidx").on(table.userAId, table.userBId),
    requesterIdx: index("friendships_requester_idx").on(table.requesterUserId),
    recipientIdx: index("friendships_recipient_idx").on(table.recipientUserId),
    userAStatusIdx: index("friendships_user_a_status_idx").on(table.userAId, table.status),
    userBStatusIdx: index("friendships_user_b_status_idx").on(table.userBId, table.status),
  }),
);

export const aiSessions = pgTable(
  "ai_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversation: jsonb("conversation").notNull(),
    searchResultCounter: integer("search_result_counter").notNull().default(1),
    searchResultsByLocalId: jsonb("search_results_by_local_id").notNull(),
    pendingApprovals: jsonb("pending_approvals").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userUpdatedAtIdx: index("ai_sessions_user_updated_at_idx").on(table.userId, table.updatedAt),
  }),
);
