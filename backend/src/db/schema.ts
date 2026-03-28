import { bigint, boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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

export const anmatProductHtmlBlobs = pgTable(
  "anmat_product_html_blobs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sourcePath: text("source_path").notNull(),
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
    ean: text("ean"),
    eanSource: text("ean_source"),
    eanCandidates: jsonb("ean_candidates"),
    parsedAt: timestamp("parsed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    htmlBlobUnique: uniqueIndex("anmat_product_derived_data_html_blob_uidx").on(table.htmlBlobId),
    nutritionFoundIdx: index("anmat_product_derived_data_nutrition_found_idx").on(table.nutritionFound),
    eanIdx: index("anmat_product_derived_data_ean_idx").on(table.ean),
  }),
);
