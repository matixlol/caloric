import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { NO_MATCHES, SUCCESS } from "../providers/myfitnesspal/barcodeProtocol.ts";
import { MfpBarcodeClient } from "../providers/myfitnesspal/MfpBarcodeClient.ts";
import { MFP_BASE_URL, MfpClient, type MfpSearchParams } from "../providers/myfitnesspal/MfpClient.ts";
import { MfpSession } from "../providers/myfitnesspal/MfpSession.ts";
import { OpenFoodFactsClient } from "../providers/openFoodFacts/OpenFoodFactsClient.ts";
import { ProviderConfig } from "../providers/ProviderConfig.ts";
import { FoodNutrition, type FoodSearchResult, type SearchSource } from "./FoodSearch.ts";
import {
  compact,
  computeOpenFoodFactsHasMore,
  countSearchItems,
  type DetailKey,
  extractDetailKeys,
  type MfpDetailPayload,
  mapMfpSearchResults,
  mapOpenFoodFactsSearchResults,
  mergeFoodResults,
  rankAnmatRows,
} from "./mapping.ts";
import { type CachedResponse, SearchRepository } from "./SearchRepository.ts";

export interface SourceSearchResult {
  readonly foods: ReadonlyArray<FoodSearchResult>;
  readonly hasMore: boolean;
}

export type BarcodeLookup =
  | { readonly _tag: "Found"; readonly cached: boolean; readonly foods: ReadonlyArray<FoodSearchResult> }
  | { readonly _tag: "NoMatches"; readonly cached: boolean }
  | { readonly _tag: "Rejected" }
  | { readonly _tag: "UpstreamFailed" };

// The cached barcode payload (barcodeProtocol's MfpBarcodePayload as JSON).
const CachedBarcodePayload = Schema.Struct({
  resultCode: Schema.Number,
  foods: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      uid: Schema.String,
      name: Schema.String,
      brand: Schema.optionalKey(Schema.String),
      serving: Schema.optionalKey(Schema.String),
      nutrition: FoodNutrition,
    }),
  ),
});
type CachedBarcodePayload = typeof CachedBarcodePayload.Type;

const mapBarcodeFoods = (payload: CachedBarcodePayload): ReadonlyArray<FoodSearchResult> =>
  payload.foods.map((food) =>
    compact({
      id: `mfp:barcode:${food.id}:${food.uid}`,
      canonicalKey: `mfp:barcode:${food.id}:${food.uid}`,
      source: "mfp" as const,
      sourceLabel: "MFP" as const,
      name: food.name,
      brand: food.brand,
      serving: food.serving,
      nutrition: food.nutrition,
    }),
  );

const make = Effect.gen(function* () {
  const config = yield* ProviderConfig;
  const repository = yield* SearchRepository;
  const mfp = yield* MfpClient;
  const mfpBarcode = yield* MfpBarcodeClient;
  const openFoodFacts = yield* OpenFoodFactsClient;

  const cacheCutoff = Effect.map(
    Clock.currentTimeMillis,
    (now) => new Date(now - Duration.toMillis(config.searchCacheTtl)),
  );

  // Detail for one search item: cached when fresh, otherwise fetched. Failed
  // fetches are recorded with status 0 so the search still renders.
  const resolveDetail = Effect.fn("FoodSearch.resolveDetail")(function* (
    searchResponseId: number,
    key: DetailKey,
    cutoff: Date,
  ) {
    const cached = yield* repository.findMfpDetail(key.foodId, key.version, cutoff);
    const response: CachedResponse = cached
      ? cached
      : yield* mfp.fetchFoodDetail(key.foodId, key.version).pipe(
          Effect.catch((error) =>
            Effect.logWarning("mfp.detail.fetch_failed", error).pipe(
              Effect.as({
                status: 0,
                url: `${MFP_BASE_URL}/api/services/foods/${key.foodId}?version=${key.version}`,
                json: null,
                text: error.message,
              }),
            ),
          ),
        );
    yield* repository.saveMfpDetail(searchResponseId, key, response);
    return { ...key, status: response.status, data: response.json } satisfies MfpDetailPayload;
  });

  // One MFP search page plus item details, through the response caches.
  const executeMfpSearch = Effect.fn("FoodSearch.executeMfpSearch")(function* (params: MfpSearchParams) {
    const cutoff = yield* cacheCutoff;
    const cached = yield* repository.findMfpSearch(params, cutoff);
    let searchResponseId: number;
    let search: CachedResponse;
    if (cached) {
      searchResponseId = cached.id;
      search = cached;
    } else {
      search = yield* mfp.searchNutrition(params);
      searchResponseId = yield* repository.saveMfpSearch(params, search);
    }
    if (!search.json) {
      return { search, details: [] };
    }
    const details = yield* Effect.forEach(
      extractDetailKeys(search.json),
      (key) => resolveDetail(searchResponseId, key, cutoff),
      { concurrency: config.detailConcurrency },
    );
    return { search, details };
  });

  const searchMfp = Effect.fn("FoodSearch.searchMfp")(function* (query: string, limit: number, page: number) {
    // The first page over-fetches to backfill rows dropped for missing
    // nutrition; deeper pages fetch exactly one window so offsets stay aligned
    // and pages don't overlap.
    const maxItems = page === 1 ? Math.min(20, Math.max(limit * 2, 8)) : limit;
    const { search, details } = yield* executeMfpSearch({
      query,
      offset: (page - 1) * limit,
      maxItems,
      countryCode: "US",
      resourceType: "foods",
    });
    return {
      foods: mapMfpSearchResults(search.json, details).slice(0, limit),
      hasMore: (countSearchItems(search.json) ?? 0) >= maxItems,
    } satisfies SourceSearchResult;
  });

  const searchOpenFoodFacts = Effect.fn("FoodSearch.searchOpenFoodFacts")(function* (
    query: string,
    limit: number,
    page: number,
  ) {
    // Keep page_size constant across pages for the paginating client (limit 20)
    // while still over-fetching on the first page for small unified limits.
    const params = { query, page, pageSize: page === 1 ? Math.min(20, Math.max(limit * 2, 8)) : limit };
    const cached = yield* repository.findOpenFoodFactsSearch(params, yield* cacheCutoff);
    let response: CachedResponse;
    if (cached) {
      response = cached;
    } else {
      response = yield* openFoodFacts.search(params);
      yield* repository.saveOpenFoodFactsSearch(params, response);
    }
    return {
      foods: mapOpenFoodFactsSearchResults(response.status, response.json).slice(0, limit),
      hasMore: computeOpenFoodFactsHasMore(response.json, page, params.pageSize),
    } satisfies SourceSearchResult;
  });

  const searchAnmat = Effect.fn("FoodSearch.searchAnmat")(function* (query: string, limit: number) {
    const rows = yield* repository.searchAnmat(query.trim());
    return rankAnmatRows(rows, query, limit);
  });

  // MFP first, then Open Food Facts. ANMAT is intentionally excluded from
  // unified results for now. Fails only when both sources fail.
  const searchUnified = Effect.fn("FoodSearch.searchUnified")(function* (query: string, limit: number) {
    const [mfpResult, offResult] = yield* Effect.all(
      [Effect.result(searchMfp(query, limit, 1)), Effect.result(searchOpenFoodFacts(query, limit, 1))],
      { concurrency: 2 },
    );
    if (Result.isFailure(mfpResult)) {
      yield* Effect.logWarning("food_search.mfp_failed", mfpResult.failure);
    }
    if (Result.isFailure(offResult)) {
      yield* Effect.logWarning("food_search.open_food_facts_failed", offResult.failure);
    }
    if (Result.isFailure(mfpResult) && Result.isFailure(offResult)) {
      return yield* Effect.fail(mfpResult.failure);
    }
    const foodsOf = <E>(result: Result.Result<SourceSearchResult, E>) =>
      Result.isSuccess(result) ? result.success.foods : [];
    return mergeFoodResults([foodsOf(mfpResult), foodsOf(offResult)], limit);
  });

  const searchBySource = Effect.fn("FoodSearch.searchBySource")(function* (
    source: SearchSource,
    query: string,
    limit: number,
    page: number,
  ) {
    switch (source) {
      case "anmat":
        // Kept queryable per source (for seeding results later) but not paginated.
        return { foods: yield* searchAnmat(query, limit), hasMore: false } satisfies SourceSearchResult;
      case "openfoodfacts":
        return yield* searchOpenFoodFacts(query, limit, page);
      case "mfp":
        return yield* searchMfp(query, limit, page);
    }
  });

  const lookupBarcode = Effect.fn("FoodSearch.lookupBarcode")(function* (barcode: string) {
    const cached = yield* repository.findBarcode(barcode, yield* cacheCutoff);
    const cachedPayload = cached ? Schema.decodeUnknownOption(CachedBarcodePayload)(cached.json) : undefined;
    if (cachedPayload?._tag === "Some") {
      const payload = cachedPayload.value;
      if (cached?.resultCode === NO_MATCHES || payload.foods.length === 0) {
        return { _tag: "NoMatches", cached: true } satisfies BarcodeLookup;
      }
      return { _tag: "Found", cached: true, foods: mapBarcodeFoods(payload) } satisfies BarcodeLookup;
    }

    const response = yield* mfpBarcode.lookup(barcode);
    yield* repository.saveBarcode({
      barcode,
      url: response.url,
      status: response.status,
      resultCode: response.data?.resultCode ?? null,
      body: response.body,
      json: response.data,
    });
    const data = response.data;
    if (!data) {
      return { _tag: "UpstreamFailed" } satisfies BarcodeLookup;
    }
    if (data.resultCode === NO_MATCHES || data.foods.length === 0) {
      return { _tag: "NoMatches", cached: false } satisfies BarcodeLookup;
    }
    if (data.resultCode !== SUCCESS) {
      return { _tag: "Rejected" } satisfies BarcodeLookup;
    }
    return { _tag: "Found", cached: false, foods: mapBarcodeFoods(data) } satisfies BarcodeLookup;
  });

  return {
    searchUnified,
    searchBySource,
    lookupBarcode,
    enqueueAnmatLiveSearch: repository.enqueueAnmatLiveSearch,
  };
});

// Food search across MyFitnessPal, Open Food Facts and the ANMAT catalog,
// with backend/'s response caching and ranking.
export class SearchService extends Context.Service<SearchService, Effect.Success<typeof make>>()(
  "caloric/search/SearchService",
) {
  static readonly layer = Layer.effect(SearchService, make).pipe(
    Layer.provide([SearchRepository.layer, MfpClient.layer, MfpBarcodeClient.layer, OpenFoodFactsClient.layer]),
    Layer.provide(MfpSession.layer),
    Layer.provide(ProviderConfig.layer),
  );
}
