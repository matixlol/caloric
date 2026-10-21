import type { FoodEntry, Recipe, UserSettings } from "../domain/Diary.ts";
import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// App tables store instants as epoch milliseconds (the API speaks milliseconds).
const millis = (name: string) => integer(name, { mode: "timestamp_ms" });
const millisNow = (name: string) =>
  millis(name)
    .notNull()
    .$defaultFn(() => new Date());
const json = <T = unknown>(name: string) => text(name, { mode: "json" }).$type<T>();
const id = () => integer("id").primaryKey({ autoIncrement: true });

// --- Provider response caches ---------------------------------------------

export const mfpAuthSessions = sqliteTable(
  "mfp_auth_sessions",
  {
    id: id(),
    provider: text("provider").notNull(),
    storageState: json("storage_state"),
    sessionStorage: json("session_storage"),
    authorization: text("authorization"),
    cookieHeader: text("cookie_header"),
    refreshedAt: millisNow("refreshed_at"),
    createdAt: millisNow("created_at"),
    updatedAt: millisNow("updated_at"),
  },
  (table) => [uniqueIndex("mfp_auth_sessions_provider_uidx").on(table.provider)],
);

export const mfpSearchResponses = sqliteTable(
  "mfp_search_responses",
  {
    id: id(),
    query: text("query").notNull(),
    offset: integer("offset").notNull(),
    maxItems: integer("max_items").notNull(),
    countryCode: text("country_code").notNull(),
    resourceType: text("resource_type").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    responseJson: json("response_json"),
    responseText: text("response_text"),
    createdAt: millisNow("created_at"),
  },
  (table) => [index("mfp_search_responses_query_created_at_idx").on(table.query, table.createdAt)],
);

export const mfpFoodDetailResponses = sqliteTable(
  "mfp_food_detail_responses",
  {
    id: id(),
    searchResponseId: integer("search_response_id")
      .references(() => mfpSearchResponses.id, { onDelete: "cascade" })
      .notNull(),
    foodId: text("food_id").notNull(),
    version: text("version").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    responseJson: json("response_json"),
    responseText: text("response_text"),
    createdAt: millisNow("created_at"),
  },
  (table) => [
    index("mfp_food_detail_responses_search_response_id_idx").on(table.searchResponseId),
    index("mfp_food_detail_responses_food_version_idx").on(table.foodId, table.version),
    uniqueIndex("mfp_food_detail_responses_search_food_version_uidx").on(
      table.searchResponseId,
      table.foodId,
      table.version,
    ),
  ],
);

export const mfpBarcodeResponses = sqliteTable(
  "mfp_barcode_responses",
  {
    id: id(),
    barcode: text("barcode").notNull(),
    mfpUrl: text("mfp_url").notNull(),
    mfpStatus: integer("mfp_status").notNull(),
    resultCode: integer("result_code"),
    responseBody: blob("response_body", { mode: "buffer" }),
    responseJson: json("response_json"),
    createdAt: millisNow("created_at"),
  },
  (table) => [index("mfp_barcode_responses_barcode_created_at_idx").on(table.barcode, table.createdAt)],
);

export const openFoodFactsSearchResponses = sqliteTable(
  "open_food_facts_search_responses",
  {
    id: id(),
    query: text("query").notNull(),
    page: integer("page").notNull(),
    pageSize: integer("page_size").notNull(),
    offUrl: text("off_url").notNull(),
    offStatus: integer("off_status").notNull(),
    responseJson: json("response_json"),
    responseText: text("response_text"),
    createdAt: millisNow("created_at"),
  },
  (table) => [index("open_food_facts_search_responses_query_created_at_idx").on(table.query, table.createdAt)],
);

// --- ANMAT product catalog ------------------------------------------------

export const anmatLiveSearchRequests = sqliteTable(
  "anmat_live_search_requests",
  {
    id: id(),
    query: text("query").notNull(),
    createdAt: millisNow("created_at"),
  },
  (table) => [index("anmat_live_search_requests_query_created_at_idx").on(table.query, table.createdAt)],
);

// Product metadata from the ANMAT crawl. The compressed HTML lives in R2
// (keyed by `htmlKey`) rather than in D1; only import jobs read it.
export const anmatProducts = sqliteTable(
  "anmat_products",
  {
    id: id(),
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
    htmlKey: text("html_key"),
    htmlSha256: text("html_sha256").notNull(),
    savedAt: millis("saved_at"),
    importedAt: millisNow("imported_at"),
  },
  (table) => [
    uniqueIndex("anmat_products_source_path_uidx").on(table.sourcePath),
    index("anmat_products_ingest_source_idx").on(table.ingestSource),
    index("anmat_products_detail_key_idx").on(table.detailKey),
    index("anmat_products_rnpa_idx").on(table.rnpa),
    index("anmat_products_marca_idx").on(table.marca),
    index("anmat_products_denominacion_idx").on(table.denominacion),
  ],
);

export const anmatProductDerivedData = sqliteTable(
  "anmat_product_derived_data",
  {
    id: id(),
    productId: integer("product_id")
      .references(() => anmatProducts.id, { onDelete: "cascade" })
      .notNull(),
    nutritionFound: integer("nutrition_found", { mode: "boolean" }).notNull(),
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
    eanAttempted: integer("ean_attempted", { mode: "boolean" }).notNull().default(true),
    eanStatus: text("ean_status").notNull().default("html_parsed"),
    ean: text("ean"),
    eanSource: text("ean_source"),
    eanCandidates: json("ean_candidates"),
    parsedAt: millisNow("parsed_at"),
  },
  (table) => [
    uniqueIndex("anmat_product_derived_data_product_uidx").on(table.productId),
    index("anmat_product_derived_data_nutrition_found_idx").on(table.nutritionFound),
    index("anmat_product_derived_data_ean_status_idx").on(table.eanStatus),
    index("anmat_product_derived_data_ean_idx").on(table.ean),
  ],
);

// Better Auth's tables (user, session, account, verification) are created by
// @alchemy.run/better-auth's deploy-time migrator, not by these migrations.

// --- User data (offline-first sync) ----------------------------------------

export const userFoodEntries = sqliteTable(
  "user_food_entries",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    data: json<FoodEntry>("data").notNull(),
    updatedAt: millis("updated_at").notNull(),
    deletedAt: millis("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id], name: "user_food_entries_pk" }),
    index("user_food_entries_user_updated_at_idx").on(table.userId, table.updatedAt),
  ],
);

export const userRecipes = sqliteTable(
  "user_recipes",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    data: json<Recipe>("data").notNull(),
    updatedAt: millis("updated_at").notNull(),
    deletedAt: millis("deleted_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id], name: "user_recipes_pk" }),
    index("user_recipes_user_updated_at_idx").on(table.userId, table.updatedAt),
  ],
);

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey(),
  data: json<UserSettings>("data").notNull(),
  updatedAt: millis("updated_at").notNull(),
});

// --- Social ---------------------------------------------------------------

export const socialProfiles = sqliteTable(
  "social_profiles",
  {
    userId: text("user_id").primaryKey(),
    displayName: text("display_name").notNull(),
    friendCode: text("friend_code").notNull(),
    createdAt: millisNow("created_at"),
    updatedAt: millisNow("updated_at"),
  },
  (table) => [uniqueIndex("social_profiles_friend_code_uidx").on(table.friendCode)],
);

const socialProfileRef = (name: string) =>
  text(name)
    .notNull()
    .references(() => socialProfiles.userId, { onDelete: "cascade" });

export const friendships = sqliteTable(
  "friendships",
  {
    id: text("id").primaryKey(),
    requesterUserId: socialProfileRef("requester_user_id"),
    recipientUserId: socialProfileRef("recipient_user_id"),
    userAId: socialProfileRef("user_a_id"),
    userBId: socialProfileRef("user_b_id"),
    status: text("status").notNull(),
    createdAt: millisNow("created_at"),
    updatedAt: millisNow("updated_at"),
  },
  (table) => [
    uniqueIndex("friendships_pair_uidx").on(table.userAId, table.userBId),
    index("friendships_requester_idx").on(table.requesterUserId),
    index("friendships_recipient_idx").on(table.recipientUserId),
    index("friendships_user_a_status_idx").on(table.userAId, table.status),
    index("friendships_user_b_status_idx").on(table.userBId, table.status),
  ],
);

// --- Assistant ------------------------------------------------------------

export const aiSessions = sqliteTable(
  "ai_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversation: json("conversation").notNull(),
    searchResultCounter: integer("search_result_counter").notNull().default(1),
    searchResultsByLocalId: json("search_results_by_local_id").notNull(),
    pendingApprovals: json("pending_approvals").notNull(),
    createdAt: millisNow("created_at"),
    updatedAt: millisNow("updated_at"),
  },
  (table) => [index("ai_sessions_user_updated_at_idx").on(table.userId, table.updatedAt)],
);
