import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

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
