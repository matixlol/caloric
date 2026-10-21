import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Db, withRuntime } from "../db/Db.ts";
import {
  anmatLiveSearchRequests,
  anmatProductDerivedData,
  anmatProducts,
  mfpBarcodeResponses,
  mfpFoodDetailResponses,
  mfpSearchResponses,
  openFoodFactsSearchResponses,
} from "../db/schema.ts";
import { NO_MATCHES, SUCCESS } from "../providers/myfitnesspal/barcodeProtocol.ts";
import type { MfpSearchParams } from "../providers/myfitnesspal/MfpClient.ts";
import type { OpenFoodFactsSearchParams } from "../providers/openFoodFacts/OpenFoodFactsClient.ts";
import type { AnmatRow } from "./mapping.ts";

// A stored provider response (and the shape fresh responses are saved in).
export interface CachedResponse {
  readonly status: number;
  readonly url: string;
  readonly json: unknown | null;
  readonly text: string | null;
}

// Postgres ILIKE '%query%' for SQLite. LIKE only folds ASCII case, so the
// pattern is a GLOB with a [xX] class per cased character (UTF-8 aware), which
// keeps accented and other non-ASCII letters case-insensitive as before.
// `%` and `_` stay wildcards as they were under ILIKE.
export const ilikeContainsPattern = (query: string): string => {
  let pattern = "*";
  for (const char of query) {
    if (char === "%") {
      pattern += "*";
    } else if (char === "_") {
      pattern += "?";
    } else if (char === "*" || char === "?" || char === "[") {
      pattern += `[${char}]`;
    } else {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      const variants = [...new Set([char, lower, upper])].filter((variant) => [...variant].length === 1);
      pattern += variants.length > 1 ? `[${variants.join("")}]` : char;
    }
  }
  return `${pattern}*`;
};

const glob = (column: SQLiteColumn, pattern: string): SQL => sql`${column} GLOB ${pattern}`;

const successfulStatus = (column: SQLiteColumn) => and(gte(column, 200), lt(column, 300));

const make = Effect.gen(function* () {
  const db = yield* Db;

  const findMfpSearch = Effect.fn("SearchRepository.findMfpSearch")(function* (
    params: MfpSearchParams,
    cutoff: Date,
  ) {
    const [row] = yield* db
      .select({
        id: mfpSearchResponses.id,
        status: mfpSearchResponses.mfpStatus,
        url: mfpSearchResponses.mfpUrl,
        json: mfpSearchResponses.responseJson,
        text: mfpSearchResponses.responseText,
      })
      .from(mfpSearchResponses)
      .where(
        and(
          eq(mfpSearchResponses.query, params.query),
          eq(mfpSearchResponses.offset, params.offset),
          eq(mfpSearchResponses.maxItems, params.maxItems),
          eq(mfpSearchResponses.countryCode, params.countryCode),
          eq(mfpSearchResponses.resourceType, params.resourceType),
          successfulStatus(mfpSearchResponses.mfpStatus),
          isNotNull(mfpSearchResponses.responseJson),
          gte(mfpSearchResponses.createdAt, cutoff),
        ),
      )
      .orderBy(desc(mfpSearchResponses.createdAt), desc(mfpSearchResponses.id))
      .limit(1);
    return row;
  }, withRuntime);

  const saveMfpSearch = Effect.fn("SearchRepository.saveMfpSearch")(function* (
    params: MfpSearchParams,
    response: CachedResponse,
  ) {
    const [row] = yield* db
      .insert(mfpSearchResponses)
      .values({
        ...params,
        mfpUrl: response.url,
        mfpStatus: response.status,
        responseJson: response.json,
        responseText: response.text,
      })
      .returning({ id: mfpSearchResponses.id });
    return row!.id;
  }, withRuntime);

  const findMfpDetail = Effect.fn("SearchRepository.findMfpDetail")(function* (
    foodId: string,
    version: string,
    cutoff: Date,
  ) {
    const [row] = yield* db
      .select({
        status: mfpFoodDetailResponses.mfpStatus,
        url: mfpFoodDetailResponses.mfpUrl,
        json: mfpFoodDetailResponses.responseJson,
        text: mfpFoodDetailResponses.responseText,
      })
      .from(mfpFoodDetailResponses)
      .where(
        and(
          eq(mfpFoodDetailResponses.foodId, foodId),
          eq(mfpFoodDetailResponses.version, version),
          successfulStatus(mfpFoodDetailResponses.mfpStatus),
          isNotNull(mfpFoodDetailResponses.responseJson),
          gte(mfpFoodDetailResponses.createdAt, cutoff),
        ),
      )
      .orderBy(desc(mfpFoodDetailResponses.createdAt), desc(mfpFoodDetailResponses.id))
      .limit(1);
    return row;
  }, withRuntime);

  // Links a detail response to the search that surfaced it (once per search).
  const saveMfpDetail = Effect.fn("SearchRepository.saveMfpDetail")(function* (
    searchResponseId: number,
    key: { readonly foodId: string; readonly version: string },
    response: CachedResponse,
  ) {
    yield* db
      .insert(mfpFoodDetailResponses)
      .values({
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        mfpUrl: response.url,
        mfpStatus: response.status,
        responseJson: response.json,
        responseText: response.text,
      })
      .onConflictDoNothing();
  }, withRuntime);

  const findOpenFoodFactsSearch = Effect.fn("SearchRepository.findOpenFoodFactsSearch")(function* (
    params: OpenFoodFactsSearchParams,
    cutoff: Date,
  ) {
    const [row] = yield* db
      .select({
        status: openFoodFactsSearchResponses.offStatus,
        url: openFoodFactsSearchResponses.offUrl,
        json: openFoodFactsSearchResponses.responseJson,
        text: openFoodFactsSearchResponses.responseText,
      })
      .from(openFoodFactsSearchResponses)
      .where(
        and(
          eq(openFoodFactsSearchResponses.query, params.query),
          eq(openFoodFactsSearchResponses.page, params.page),
          eq(openFoodFactsSearchResponses.pageSize, params.pageSize),
          successfulStatus(openFoodFactsSearchResponses.offStatus),
          isNotNull(openFoodFactsSearchResponses.responseJson),
          gte(openFoodFactsSearchResponses.createdAt, cutoff),
        ),
      )
      .orderBy(desc(openFoodFactsSearchResponses.createdAt), desc(openFoodFactsSearchResponses.id))
      .limit(1);
    return row;
  }, withRuntime);

  const saveOpenFoodFactsSearch = Effect.fn("SearchRepository.saveOpenFoodFactsSearch")(function* (
    params: OpenFoodFactsSearchParams,
    response: CachedResponse,
  ) {
    yield* db.insert(openFoodFactsSearchResponses).values({
      ...params,
      offUrl: response.url,
      offStatus: response.status,
      responseJson: response.json,
      responseText: response.text,
    });
  }, withRuntime);

  const findBarcode = Effect.fn("SearchRepository.findBarcode")(function* (barcode: string, cutoff: Date) {
    const [row] = yield* db
      .select({ resultCode: mfpBarcodeResponses.resultCode, json: mfpBarcodeResponses.responseJson })
      .from(mfpBarcodeResponses)
      .where(
        and(
          eq(mfpBarcodeResponses.barcode, barcode),
          successfulStatus(mfpBarcodeResponses.mfpStatus),
          inArray(mfpBarcodeResponses.resultCode, [SUCCESS, NO_MATCHES]),
          isNotNull(mfpBarcodeResponses.responseJson),
          gte(mfpBarcodeResponses.createdAt, cutoff),
        ),
      )
      .orderBy(desc(mfpBarcodeResponses.createdAt), desc(mfpBarcodeResponses.id))
      .limit(1);
    return row;
  }, withRuntime);

  const saveBarcode = Effect.fn("SearchRepository.saveBarcode")(function* (row: {
    readonly barcode: string;
    readonly url: string;
    readonly status: number;
    readonly resultCode: number | null;
    readonly body: Uint8Array;
    readonly json: unknown | null;
  }) {
    yield* db.insert(mfpBarcodeResponses).values({
      barcode: row.barcode,
      mfpUrl: row.url,
      mfpStatus: row.status,
      resultCode: row.resultCode,
      responseBody: Buffer.from(row.body),
      responseJson: row.json,
    });
  }, withRuntime);

  const enqueueAnmatLiveSearch = Effect.fn("SearchRepository.enqueueAnmatLiveSearch")(function* (query: string) {
    const [row] = yield* db
      .insert(anmatLiveSearchRequests)
      .values({ query })
      .returning({ id: anmatLiveSearchRequests.id, createdAt: anmatLiveSearchRequests.createdAt });
    return row!;
  }, withRuntime);

  // Every catalog row whose name, brand, owner or RNPA contains the query
  // (newest first); ranking happens in memory as in backend/.
  const searchAnmat = Effect.fn("SearchRepository.searchAnmat")(function* (query: string) {
    const pattern = ilikeContainsPattern(query);
    const rows: ReadonlyArray<AnmatRow> = yield* db
      .select({
        productId: anmatProducts.id,
        ingestSource: anmatProducts.ingestSource,
        detailKey: anmatProducts.detailKey,
        rnpa: anmatProducts.rnpa,
        denominacion: anmatProducts.denominacion,
        nombreFantasia: anmatProducts.nombreFantasia,
        marca: anmatProducts.marca,
        titular: anmatProducts.titular,
        importedAt: anmatProducts.importedAt,
        nutritionFound: anmatProductDerivedData.nutritionFound,
        servingText: anmatProductDerivedData.servingText,
        servingQuantity: anmatProductDerivedData.servingQuantity,
        servingUnit: anmatProductDerivedData.servingUnit,
        calories: anmatProductDerivedData.calories,
        proteinGrams: anmatProductDerivedData.proteinGrams,
        carbsGrams: anmatProductDerivedData.carbsGrams,
        fatGrams: anmatProductDerivedData.fatGrams,
        fiberGrams: anmatProductDerivedData.fiberGrams,
        sugarsGrams: anmatProductDerivedData.sugarsGrams,
        sodiumMg: anmatProductDerivedData.sodiumMg,
      })
      .from(anmatProducts)
      .leftJoin(anmatProductDerivedData, eq(anmatProductDerivedData.productId, anmatProducts.id))
      .where(
        or(
          glob(anmatProducts.denominacion, pattern),
          glob(anmatProducts.nombreFantasia, pattern),
          glob(anmatProducts.marca, pattern),
          glob(anmatProducts.titular, pattern),
          glob(anmatProducts.rnpa, pattern),
        ),
      )
      .orderBy(desc(anmatProducts.importedAt), desc(anmatProducts.id));
    return rows;
  }, withRuntime);

  return {
    findMfpSearch,
    saveMfpSearch,
    findMfpDetail,
    saveMfpDetail,
    findOpenFoodFactsSearch,
    saveOpenFoodFactsSearch,
    findBarcode,
    saveBarcode,
    enqueueAnmatLiveSearch,
    searchAnmat,
  };
});

// D1 access for the provider response caches, the ANMAT catalog and the
// ANMAT live-search queue.
export class SearchRepository extends Context.Service<SearchRepository, Effect.Success<typeof make>>()(
  "caloric/search/SearchRepository",
) {
  static readonly layer = Layer.effect(SearchRepository, make);
}
