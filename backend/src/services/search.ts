import { and, desc, eq, gte, ilike, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import {
  anmatLiveSearchRequests,
  anmatProductDerivedData,
  anmatProductHtmlBlobs,
  mfpFoodDetailResponses,
  mfpSearchResponses,
  openFoodFactsSearchResponses,
} from "../db/schema";
import { logError, logInfo, summarizeText } from "../logging";
import { normalizeTextValue } from "../providers/anmat/html";
import { fetchFoodDetail, searchNutrition } from "../providers/myfitnesspal/client";
import { getMfpAuthHeaders, MFP_BASE_URL } from "../providers/myfitnesspal/session";
import { OPEN_FOOD_FACTS_BASE_URL, searchOpenFoodFacts } from "../providers/open-food-facts/client";
import { Sentry } from "../lib/sentry";
import { createMfpTraceId } from "../id";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

type SearchItem = {
  item?: {
    id?: string | number;
    version?: string | number;
  };
};

type StoredSearchResponse = {
  id: number;
  mfpStatus: number;
  mfpUrl: string;
  responseJson: unknown | null;
  responseText: string | null;
};

type StoredDetailResponse = {
  mfpStatus: number;
  mfpUrl: string;
  responseJson: unknown | null;
  responseText: string | null;
};

type StoredOpenFoodFactsSearchResponse = {
  id: number;
  offStatus: number;
  offUrl: string;
  responseJson: unknown | null;
  responseText: string | null;
};

type SearchParams = {
  query: string;
  offset: number;
  maxItems: number;
  countryCode: string;
  resourceType: string;
  includeDetails: boolean;
};

type SearchResponsePayload = {
  searchResponseId: number;
  search: {
    status: number;
    url: string;
    data: unknown | null;
    text: string | null;
  };
  detailCount: number;
  details: Array<{
    foodId: string;
    version: string;
    status: number;
    data: unknown | null;
    text: string | null;
  }>;
};

type MfpNutritionalContents = {
  energy?: {
    value?: unknown;
  };
  protein?: unknown;
  carbohydrates?: unknown;
  fat?: unknown;
  fiber?: unknown;
  sugar?: unknown;
  sodium?: unknown;
  potassium?: unknown;
};

type MfpServingSize = {
  value?: unknown;
  unit?: unknown;
};

type MfpFood = {
  id?: unknown;
  version?: unknown;
  description?: unknown;
  brand_name?: unknown;
  serving_sizes?: unknown;
  nutritional_contents?: MfpNutritionalContents | null;
};

type SearchSource = "mfp" | "anmat" | "openfoodfacts";

function parseSearchSource(value: string | null | undefined): SearchSource | null {
  if (value === "mfp" || value === "anmat" || value === "openfoodfacts") {
    return value;
  }

  return null;
}

type FoodNutrition = {
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
  sugars?: number;
  sodiumMg?: number;
  potassiumMg?: number;
};

type FoodSearchResult = {
  id: string;
  canonicalKey: string;
  source: SearchSource;
  sourceLabel: "MFP" | "ANMAT" | "OFF";
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: FoodNutrition;
};

export type SearchResultFood = FoodSearchResult & {
  resultId: string;
};

function buildMfpSearchTraceId(): string {
  return createMfpTraceId();
}

function countSearchItems(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : null;
}

const UNKNOWN_PUBLIC_ERROR_MESSAGE = "Unknown error.";

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function toErrorForCapture(error: unknown, code: string): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(`${code}: ${summarizeText(stringifyUnknownError(error), 500)}`);
}

function reportUnknownError(code: string, error: unknown): Response {
  const errorForCapture = toErrorForCapture(error, code);

  Sentry.getActiveSpan()?.setAttributes({
    "app.error.code": code,
    "app.error.exposed": false,
  });

  logError(`api.${code}`, errorForCapture);
  Sentry.captureException(errorForCapture);

  return json(
    {
      error: code,
      message: UNKNOWN_PUBLIC_ERROR_MESSAGE,
    },
    502,
  );
}

function encodeSseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseInteger(value: string | null, fallback: number): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null || value.trim() === "") {
    return fallback;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function formatServing(servingSizes: unknown): string | undefined {
  if (!Array.isArray(servingSizes)) {
    return undefined;
  }

  for (const candidate of servingSizes) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const serving = candidate as MfpServingSize;
    const value = asNumber(serving.value);
    const unit = asString(serving.unit);

    if (value !== undefined && unit) {
      return `${value} ${unit}`;
    }

    if (value !== undefined) {
      return String(value);
    }

    if (unit) {
      return unit;
    }
  }

  return undefined;
}

function mapNutrition(contents: MfpNutritionalContents | null | undefined): SearchResultFood["nutrition"] {
  if (!contents) {
    return undefined;
  }

  const nutrition = {
    calories: asNumber(contents.energy?.value),
    protein: asNumber(contents.protein),
    carbs: asNumber(contents.carbohydrates),
    fat: asNumber(contents.fat),
    fiber: asNumber(contents.fiber),
    sugars: asNumber(contents.sugar),
    sodiumMg: asNumber(contents.sodium),
    potassiumMg: asNumber(contents.potassium),
  };

  if (Object.values(nutrition).every((value) => value === undefined)) {
    return undefined;
  }

  return nutrition;
}

function hasNutrition(
  nutrition: FoodSearchResult["nutrition"],
): nutrition is NonNullable<FoodSearchResult["nutrition"]> {
  return !!nutrition && Object.values(nutrition).some((value) => value !== undefined);
}

function getSearchCacheCutoff(): Date {
  return new Date(Date.now() - config.searchCacheTtlDays * 24 * 60 * 60 * 1000);
}

function toSearchPayload(record: StoredSearchResponse): {
  status: number;
  url: string;
  data: unknown | null;
  text: string | null;
} {
  return {
    status: record.mfpStatus,
    url: record.mfpUrl,
    data: record.responseJson,
    text: record.responseText,
  };
}

function toOpenFoodFactsSearchPayload(record: StoredOpenFoodFactsSearchResponse): {
  status: number;
  url: string;
  data: unknown | null;
  text: string | null;
} {
  return {
    status: record.offStatus,
    url: record.offUrl,
    data: record.responseJson,
    text: record.responseText,
  };
}

function toDetailPayload(
  key: { foodId: string; version: string },
  record: StoredDetailResponse,
): {
  foodId: string;
  version: string;
  status: number;
  data: unknown | null;
  text: string | null;
} {
  return {
    foodId: key.foodId,
    version: key.version,
    status: record.mfpStatus,
    data: record.responseJson,
    text: record.responseText,
  };
}

function isSuccessfulMfpStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

async function findCachedSearch(params: {
  query: string;
  offset: number;
  maxItems: number;
  countryCode: string;
  resourceType: string;
}): Promise<StoredSearchResponse | null> {
  const cacheCutoff = getSearchCacheCutoff();
  const [cachedSearch] = await db
    .select({
      id: mfpSearchResponses.id,
      mfpStatus: mfpSearchResponses.mfpStatus,
      mfpUrl: mfpSearchResponses.mfpUrl,
      responseJson: mfpSearchResponses.responseJson,
      responseText: mfpSearchResponses.responseText,
    })
    .from(mfpSearchResponses)
    .where(
      and(
        eq(mfpSearchResponses.query, params.query),
        eq(mfpSearchResponses.offset, params.offset),
        eq(mfpSearchResponses.maxItems, params.maxItems),
        eq(mfpSearchResponses.countryCode, params.countryCode),
        eq(mfpSearchResponses.resourceType, params.resourceType),
        gte(mfpSearchResponses.mfpStatus, 200),
        lt(mfpSearchResponses.mfpStatus, 300),
        isNotNull(mfpSearchResponses.responseJson),
        gte(mfpSearchResponses.createdAt, cacheCutoff),
      ),
    )
    .orderBy(desc(mfpSearchResponses.createdAt), desc(mfpSearchResponses.id))
    .limit(1);

  return cachedSearch ?? null;
}

async function findCachedDetail(foodId: string, version: string): Promise<StoredDetailResponse | null> {
  const cacheCutoff = getSearchCacheCutoff();
  const [cachedDetail] = await db
    .select({
      mfpStatus: mfpFoodDetailResponses.mfpStatus,
      mfpUrl: mfpFoodDetailResponses.mfpUrl,
      responseJson: mfpFoodDetailResponses.responseJson,
      responseText: mfpFoodDetailResponses.responseText,
    })
    .from(mfpFoodDetailResponses)
    .where(
      and(
        eq(mfpFoodDetailResponses.foodId, foodId),
        eq(mfpFoodDetailResponses.version, version),
        gte(mfpFoodDetailResponses.mfpStatus, 200),
        lt(mfpFoodDetailResponses.mfpStatus, 300),
        isNotNull(mfpFoodDetailResponses.responseJson),
        gte(mfpFoodDetailResponses.createdAt, cacheCutoff),
      ),
    )
    .orderBy(desc(mfpFoodDetailResponses.createdAt), desc(mfpFoodDetailResponses.id))
    .limit(1);

  return cachedDetail ?? null;
}

async function findCachedOpenFoodFactsSearch(params: {
  query: string;
  page: number;
  pageSize: number;
}): Promise<StoredOpenFoodFactsSearchResponse | null> {
  const cacheCutoff = getSearchCacheCutoff();
  const [cachedSearch] = await db
    .select({
      id: openFoodFactsSearchResponses.id,
      offStatus: openFoodFactsSearchResponses.offStatus,
      offUrl: openFoodFactsSearchResponses.offUrl,
      responseJson: openFoodFactsSearchResponses.responseJson,
      responseText: openFoodFactsSearchResponses.responseText,
    })
    .from(openFoodFactsSearchResponses)
    .where(
      and(
        eq(openFoodFactsSearchResponses.query, params.query),
        eq(openFoodFactsSearchResponses.page, params.page),
        eq(openFoodFactsSearchResponses.pageSize, params.pageSize),
        gte(openFoodFactsSearchResponses.offStatus, 200),
        lt(openFoodFactsSearchResponses.offStatus, 300),
        isNotNull(openFoodFactsSearchResponses.responseJson),
        gte(openFoodFactsSearchResponses.createdAt, cacheCutoff),
      ),
    )
    .orderBy(desc(openFoodFactsSearchResponses.createdAt), desc(openFoodFactsSearchResponses.id))
    .limit(1);

  return cachedSearch ?? null;
}

async function saveDetailForSearch(params: {
  searchResponseId: number;
  foodId: string;
  version: string;
  mfpUrl: string;
  mfpStatus: number;
  responseJson: unknown | null;
  responseText: string | null;
}): Promise<void> {
  await db
    .insert(mfpFoodDetailResponses)
    .values({
      searchResponseId: params.searchResponseId,
      foodId: params.foodId,
      version: params.version,
      mfpUrl: params.mfpUrl,
      mfpStatus: params.mfpStatus,
      responseJson: params.responseJson,
      responseText: params.responseText,
    })
    .onConflictDoNothing();
}

async function saveOpenFoodFactsSearch(params: {
  query: string;
  page: number;
  pageSize: number;
  offUrl: string;
  offStatus: number;
  responseJson: unknown | null;
  responseText: string | null;
}): Promise<void> {
  await db.insert(openFoodFactsSearchResponses).values({
    query: params.query,
    page: params.page,
    pageSize: params.pageSize,
    offUrl: params.offUrl,
    offStatus: params.offStatus,
    responseJson: params.responseJson,
    responseText: params.responseText,
  });
}

async function enqueueAnmatLiveSearch(query: string): Promise<{ id: number; createdAt: Date }> {
  const [request] = await db
    .insert(anmatLiveSearchRequests)
    .values({ query })
    .returning({
      id: anmatLiveSearchRequests.id,
      createdAt: anmatLiveSearchRequests.createdAt,
    });

  return request;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await tasks[current]();
    }
  });

  await Promise.all(workers);
  return results;
}

function extractDetailKeys(searchJson: unknown): Array<{ foodId: string; version: string }> {
  if (!searchJson || typeof searchJson !== "object") {
    return [];
  }

  const items = (searchJson as { items?: SearchItem[] }).items;
  if (!items || !Array.isArray(items)) {
    return [];
  }

  const dedupe = new Set<string>();
  const keys: Array<{ foodId: string; version: string }> = [];

  for (const row of items) {
    const id = row?.item?.id;
    const version = row?.item?.version;
    if (id === undefined || version === undefined) {
      continue;
    }

    const foodId = String(id);
    const foodVersion = String(version);
    const unique = `${foodId}:${foodVersion}`;
    if (dedupe.has(unique)) {
      continue;
    }
    dedupe.add(unique);
    keys.push({ foodId, version: foodVersion });
  }

  return keys;
}

async function executeSearch(params: SearchParams): Promise<SearchResponsePayload> {
  const traceId = buildMfpSearchTraceId();
  const searchLookup = {
    query: params.query,
    offset: params.offset,
    maxItems: params.maxItems,
    countryCode: params.countryCode,
    resourceType: params.resourceType,
  };
  const startedAt = Date.now();

  logInfo("mfp.search.start", {
    traceId,
    query: params.query,
    offset: params.offset,
    maxItems: params.maxItems,
    countryCode: params.countryCode,
    resourceType: params.resourceType,
    includeDetails: params.includeDetails,
    detailConcurrency: config.detailConcurrency,
  });

  const cachedSearch = await findCachedSearch(searchLookup);

  let searchResponseId = 0;
  let searchPayload: {
    status: number;
    url: string;
    data: unknown | null;
    text: string | null;
  };

  if (cachedSearch) {
    searchResponseId = cachedSearch.id;
    searchPayload = toSearchPayload(cachedSearch);
    logInfo("mfp.search.cache_hit", {
      traceId,
      searchResponseId,
      status: cachedSearch.mfpStatus,
      url: cachedSearch.mfpUrl,
      itemCount: countSearchItems(cachedSearch.responseJson),
      textPreview: summarizeText(cachedSearch.responseText),
    });
  } else {
    const searchResponse = await searchNutrition(searchLookup);

    if (!isSuccessfulMfpStatus(searchResponse.status) || !searchResponse.json) {
      throw new Error(
        `MyFitnessPal search failed with status ${searchResponse.status}${searchResponse.text ? `: ${summarizeText(searchResponse.text)}` : ""}`,
      );
    }

    const [savedSearch] = await db
      .insert(mfpSearchResponses)
      .values({
        query: params.query,
        offset: params.offset,
        maxItems: params.maxItems,
        countryCode: params.countryCode,
        resourceType: params.resourceType,
        mfpUrl: searchResponse.url,
        mfpStatus: searchResponse.status,
        responseJson: searchResponse.json,
        responseText: searchResponse.text,
      })
      .returning({ id: mfpSearchResponses.id });

    searchResponseId = savedSearch.id;
    searchPayload = {
      status: searchResponse.status,
      url: searchResponse.url,
      data: searchResponse.json,
      text: searchResponse.text,
    };

    logInfo("mfp.search.fetched", {
      traceId,
      searchResponseId,
      status: searchResponse.status,
      url: searchResponse.url,
      itemCount: countSearchItems(searchResponse.json),
      textPreview: summarizeText(searchResponse.text),
    });
  }

  if (!params.includeDetails || !searchPayload.data) {
    logInfo("mfp.search.complete", {
      traceId,
      searchResponseId,
      detailCount: 0,
      durationMs: Date.now() - startedAt,
      resultItemCount: countSearchItems(searchPayload.data),
      skippedDetails: !params.includeDetails ? "include_details_false" : "missing_search_data",
    });
    return {
      searchResponseId,
      search: searchPayload,
      detailCount: 0,
      details: [],
    };
  }

  const detailKeys = extractDetailKeys(searchPayload.data);

  logInfo("mfp.search.detail_keys", {
    traceId,
    searchResponseId,
    detailKeyCount: detailKeys.length,
  });

  const detailTasks = detailKeys.map((key) => async () => {
    const cachedDetail = await findCachedDetail(key.foodId, key.version);
    if (cachedDetail) {
      logInfo("mfp.detail.cache_hit", {
        traceId,
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        status: cachedDetail.mfpStatus,
        url: cachedDetail.mfpUrl,
        textPreview: summarizeText(cachedDetail.responseText),
      });

      await saveDetailForSearch({
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        mfpUrl: cachedDetail.mfpUrl,
        mfpStatus: cachedDetail.mfpStatus,
        responseJson: cachedDetail.responseJson,
        responseText: cachedDetail.responseText,
      });

      return toDetailPayload(key, cachedDetail);
    }

    try {
      logInfo("mfp.detail.fetch_start", {
        traceId,
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
      });

      const detailResponse = await fetchFoodDetail(key.foodId, key.version);

      await saveDetailForSearch({
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        mfpUrl: detailResponse.url,
        mfpStatus: detailResponse.status,
        responseJson: detailResponse.json,
        responseText: detailResponse.text,
      });

      logInfo("mfp.detail.fetch_complete", {
        traceId,
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        status: detailResponse.status,
        url: detailResponse.url,
        textPreview: summarizeText(detailResponse.text),
      });

      return toDetailPayload(key, {
        mfpStatus: detailResponse.status,
        mfpUrl: detailResponse.url,
        responseJson: detailResponse.json,
        responseText: detailResponse.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fallbackUrl = `${MFP_BASE_URL}/api/services/foods/${key.foodId}?version=${key.version}`;

      logError("mfp.detail.fetch_failed", error, {
        traceId,
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        fallbackUrl,
      });

      await saveDetailForSearch({
        searchResponseId,
        foodId: key.foodId,
        version: key.version,
        mfpUrl: fallbackUrl,
        mfpStatus: 0,
        responseJson: null,
        responseText: message,
      });

      return toDetailPayload(key, {
        mfpStatus: 0,
        mfpUrl: fallbackUrl,
        responseJson: null,
        responseText: message,
      });
    }
  });

  const details = await runWithConcurrency(detailTasks, config.detailConcurrency);

  logInfo("mfp.search.complete", {
    traceId,
    searchResponseId,
    searchStatus: searchPayload.status,
    detailCount: details.length,
    detailSuccessCount: details.filter((detail) => detail.status === 200).length,
    durationMs: Date.now() - startedAt,
    resultItemCount: countSearchItems(searchPayload.data),
  });

  return {
    searchResponseId,
    search: searchPayload,
    detailCount: details.length,
    details,
  };
}

function mapMfpSearchResults(payload: SearchResponsePayload): FoodSearchResult[] {
  const detailById = new Map<string, MfpFood>();

  for (const detail of payload.details ?? []) {
    const status = asNumber(detail.status);
    if (status !== 200 || !detail.data || typeof detail.data !== "object") {
      continue;
    }

    const foodId = asString(detail.foodId);
    const version = asString(detail.version);
    if (!foodId || !version) {
      continue;
    }

    detailById.set(`${foodId}:${version}`, detail.data as MfpFood);
  }

  const items = payload.search.data && typeof payload.search.data === "object"
    ? (payload.search.data as { items?: { item?: MfpFood | null }[] }).items
    : undefined;

  if (!Array.isArray(items)) {
    return [];
  }

  const results: FoodSearchResult[] = [];
  const seen = new Set<string>();

  for (const row of items) {
    const item = row?.item;
    if (!item || typeof item !== "object") {
      continue;
    }

    const foodId = asString(item.id);
    const version = asString(item.version);
    if (!foodId || !version) {
      continue;
    }

    const compositeId = `${foodId}:${version}`;
    if (seen.has(compositeId)) {
      continue;
    }
    seen.add(compositeId);

    const detail = detailById.get(compositeId);
    const source = detail ?? item;
    const name = asString(source.description) ?? asString(item.description);
    if (!name) {
      continue;
    }

    const brand = asString(source.brand_name) ?? asString(item.brand_name);
    const serving = formatServing(source.serving_sizes) ?? formatServing(item.serving_sizes);
    const nutrition = mapNutrition(source.nutritional_contents ?? item.nutritional_contents);
    if (!hasNutrition(nutrition)) {
      continue;
    }

    results.push({
      id: `mfp:${compositeId}`,
      canonicalKey: `mfp:${compositeId}`,
      source: "mfp",
      sourceLabel: "MFP",
      name,
      brand,
      serving,
      nutrition,
    });
  }

  return results;
}

type OpenFoodFactsNutriments = Record<string, unknown>;

type OpenFoodFactsProduct = {
  code?: unknown;
  product_name?: unknown;
  brands?: unknown;
  quantity?: unknown;
  serving_size?: unknown;
  nutriments?: OpenFoodFactsNutriments | null;
};

function getOpenFoodFactsValue(
  nutriments: OpenFoodFactsNutriments | null | undefined,
  key: string,
  preferServing: boolean,
): number | undefined {
  if (!nutriments) {
    return undefined;
  }

  if (preferServing) {
    const servingValue = asNumber(nutriments[`${key}_serving`]);
    if (servingValue !== undefined) {
      return servingValue;
    }
  }

  return (
    asNumber(nutriments[`${key}_100g`]) ??
    asNumber(nutriments[`${key}_value`]) ??
    asNumber(nutriments[key])
  );
}

function convertOpenFoodFactsMineralToMg(
  nutriments: OpenFoodFactsNutriments | null | undefined,
  key: string,
  preferServing: boolean,
): number | undefined {
  const value =
    (preferServing ? asNumber(nutriments?.[`${key}_serving`]) : undefined) ??
    asNumber(nutriments?.[`${key}_100g`]) ??
    asNumber(nutriments?.[`${key}_value`]) ??
    asNumber(nutriments?.[key]);
  if (value === undefined) {
    return undefined;
  }

  const normalizedUnit = asString(nutriments?.[`${key}_unit`])?.toLowerCase();
  if (!normalizedUnit || normalizedUnit === "mg") {
    return value;
  }
  if (normalizedUnit === "g") {
    return value * 1000;
  }
  if (normalizedUnit === "kg") {
    return value * 1_000_000;
  }
  if (normalizedUnit === "µg" || normalizedUnit === "ug") {
    return value / 1000;
  }

  return value;
}

function mapOpenFoodFactsNutrition(
  nutriments: OpenFoodFactsNutriments | null | undefined,
  preferServing: boolean,
): FoodSearchResult["nutrition"] {
  const nutrition = {
    calories: getOpenFoodFactsValue(nutriments, "energy-kcal", preferServing),
    protein: getOpenFoodFactsValue(nutriments, "proteins", preferServing),
    carbs: getOpenFoodFactsValue(nutriments, "carbohydrates", preferServing),
    fat: getOpenFoodFactsValue(nutriments, "fat", preferServing),
    fiber: getOpenFoodFactsValue(nutriments, "fiber", preferServing),
    sugars: getOpenFoodFactsValue(nutriments, "sugars", preferServing),
    sodiumMg: convertOpenFoodFactsMineralToMg(nutriments, "sodium", preferServing),
    potassiumMg: convertOpenFoodFactsMineralToMg(nutriments, "potassium", preferServing),
  };

  return hasNutrition(nutrition) ? nutrition : undefined;
}

function mapOpenFoodFactsSearchResults(payload: {
  status: number;
  url: string;
  data: unknown | null;
  text: string | null;
}): FoodSearchResult[] {
  if (payload.status < 200 || payload.status >= 300) {
    return [];
  }

  const body = asRecord(payload.data);
  const products = Array.isArray(body?.products) ? body.products : [];
  const results: FoodSearchResult[] = [];
  const seen = new Set<string>();

  for (const value of products) {
    const product = asRecord(value) as OpenFoodFactsProduct | null;
    const code = asString(product?.code);
    const name = asString(product?.product_name);
    if (!code || !name || seen.has(code)) {
      continue;
    }

    const rawServing = asString(product?.serving_size) || asString(product?.quantity);
    const hasServingData = !!asNumber(product?.nutriments?.["energy-kcal_serving"]);
    const nutrition = mapOpenFoodFactsNutrition(product?.nutriments ?? null, hasServingData);

    if (!nutrition) {
      continue;
    }

    let serving = rawServing;
    if (!hasServingData) {
      serving = rawServing ? `${rawServing} (per 100g)` : "100g";
    }

    seen.add(code);
    results.push({
      id: `off:${code}`,
      canonicalKey: `off:${code}`,
      source: "openfoodfacts",
      sourceLabel: "OFF",
      name,
      brand: asString(product?.brands),
      serving,
      nutrition,
    });
  }

  return results;
}

function parseTextNumber(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeSearchText(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function buildAnmatCanonicalKey(fields: {
  detailKey?: string | null;
  rnpa?: string | null;
  nombreFantasia?: string | null;
  denominacion?: string | null;
  marca?: string | null;
}): string {
  const detailKey = normalizeSearchText(fields.detailKey);
  if (detailKey) {
    return `anmat:detail:${detailKey}`;
  }

  const rnpa = normalizeSearchText(fields.rnpa);
  if (rnpa) {
    return `anmat:rnpa:${rnpa}`;
  }

  return `anmat:text:${[
    normalizeSearchText(fields.nombreFantasia),
    normalizeSearchText(fields.denominacion),
    normalizeSearchText(fields.marca),
  ]
    .filter(Boolean)
    .join("|")}`;
}

function scoreSearchField(value: string | null | undefined, queryLower: string, queryTokens: string[]): number {
  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return 0;
  }

  if (normalized === queryLower) {
    return 140;
  }

  if (normalized.startsWith(queryLower)) {
    return 90;
  }

  if (queryTokens.length > 1 && queryTokens.every((token) => normalized.includes(token))) {
    return 60;
  }

  if (normalized.includes(queryLower)) {
    return 40;
  }

  const matchedTokens = queryTokens.filter((token) => normalized.includes(token)).length;
  return matchedTokens * 8;
}

function mapAnmatRowToFood(row: {
  htmlBlobId: number;
  detailKey: string | null;
  rnpa: string | null;
  denominacion: string | null;
  nombreFantasia: string | null;
  marca: string | null;
  servingText: string | null;
  servingQuantity: number | null;
  servingUnit: string | null;
  calories: number | null;
  proteinGrams: string | null;
  carbsGrams: string | null;
  fatGrams: string | null;
  fiberGrams: string | null;
  sugarsGrams: string | null;
  sodiumMg: number | null;
}): FoodSearchResult | null {
  const name = row.nombreFantasia?.trim() || row.denominacion?.trim() || null;
  if (!name) {
    return null;
  }

  const serving =
    row.servingText?.trim() ||
    (row.servingQuantity !== null && row.servingQuantity !== undefined && row.servingUnit
      ? `${row.servingQuantity} ${row.servingUnit}`
      : undefined);

  const nutrition = {
    calories: row.calories ?? undefined,
    protein: parseTextNumber(row.proteinGrams),
    carbs: parseTextNumber(row.carbsGrams),
    fat: parseTextNumber(row.fatGrams),
    fiber: parseTextNumber(row.fiberGrams),
    sugars: parseTextNumber(row.sugarsGrams),
    sodiumMg: row.sodiumMg ?? undefined,
  };
  if (!hasNutrition(nutrition)) {
    return null;
  }

  return {
    id: `anmat:${row.htmlBlobId}`,
    canonicalKey: buildAnmatCanonicalKey(row),
    source: "anmat",
    sourceLabel: "ANMAT",
    name,
    brand: row.marca ?? undefined,
    serving,
    nutrition,
  };
}

async function searchLocalAnmatFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  const normalizedQuery = query.trim();

  return Sentry.startSpan(
    {
      name: "food_search.anmat.local",
      op: "food.search",
      attributes: {
        "app.search.query_length": normalizedQuery.length,
        "app.search.limit": limit,
      },
    },
    async (span) => {
      const queryLower = normalizedQuery.toLowerCase();
      const queryTokens = queryLower.split(/\s+/).filter(Boolean);
      const pattern = `%${normalizedQuery}%`;

      const rows = await db
        .select({
          htmlBlobId: anmatProductHtmlBlobs.id,
          ingestSource: anmatProductHtmlBlobs.ingestSource,
          detailKey: anmatProductHtmlBlobs.detailKey,
          rnpa: anmatProductHtmlBlobs.rnpa,
          denominacion: anmatProductHtmlBlobs.denominacion,
          nombreFantasia: anmatProductHtmlBlobs.nombreFantasia,
          marca: anmatProductHtmlBlobs.marca,
          titular: anmatProductHtmlBlobs.titular,
          importedAt: anmatProductHtmlBlobs.importedAt,
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
        .from(anmatProductHtmlBlobs)
        .leftJoin(anmatProductDerivedData, eq(anmatProductDerivedData.htmlBlobId, anmatProductHtmlBlobs.id))
        .where(
          or(
            ilike(anmatProductHtmlBlobs.denominacion, pattern),
            ilike(anmatProductHtmlBlobs.nombreFantasia, pattern),
            ilike(anmatProductHtmlBlobs.marca, pattern),
            ilike(anmatProductHtmlBlobs.titular, pattern),
            ilike(anmatProductHtmlBlobs.rnpa, pattern),
          ),
        )
        .orderBy(desc(anmatProductHtmlBlobs.importedAt), desc(anmatProductHtmlBlobs.id));

      const deduped = new Map<
        string,
        {
          score: number;
          liveRank: number;
          importedAtMs: number;
          food: FoodSearchResult;
        }
      >();

      for (const row of rows) {
        const food = mapAnmatRowToFood(row);
        if (!food) {
          continue;
        }

        const score =
          scoreSearchField(row.nombreFantasia, queryLower, queryTokens) * 1.2 +
          scoreSearchField(row.denominacion, queryLower, queryTokens) +
          scoreSearchField(row.marca, queryLower, queryTokens) * 0.85 +
          scoreSearchField(row.titular, queryLower, queryTokens) * 0.35 +
          scoreSearchField(row.rnpa, queryLower, queryTokens) * 0.5 +
          (row.nutritionFound ? 12 : 0) +
          (row.ingestSource === "live_search" ? 6 : 0);

        if (score <= 0) {
          continue;
        }

        const liveRank = row.ingestSource === "live_search" ? 1 : 0;
        const importedAtMs = row.importedAt instanceof Date ? row.importedAt.getTime() : 0;
        const current = deduped.get(food.canonicalKey);

        if (
          !current ||
          score > current.score ||
          (score === current.score && liveRank > current.liveRank) ||
          (score === current.score && liveRank === current.liveRank && importedAtMs > current.importedAtMs)
        ) {
          deduped.set(food.canonicalKey, { score, liveRank, importedAtMs, food });
        }
      }

      const results = [...deduped.values()]
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          if (right.liveRank !== left.liveRank) {
            return right.liveRank - left.liveRank;
          }
          return right.importedAtMs - left.importedAtMs;
        })
        .slice(0, limit)
        .map((entry) => entry.food);

      span.setAttribute("app.search.result_count", results.length);
      span.setAttribute("app.search.db_row_count", rows.length);
      return results;
    },
  );
}

async function searchMfpFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  const startedAt = Date.now();

  return Sentry.startSpan(
    {
      name: "food_search.mfp",
      op: "food.search",
      attributes: {
        "app.search.query_length": query.trim().length,
        "app.search.limit": limit,
      },
    },
    async (span) => {
      logInfo("mfp.search_foods.start", {
        query,
        limit,
      });

      const searchPayload = await executeSearch({
        query,
        offset: 0,
        maxItems: Math.min(20, Math.max(limit * 2, 8)),
        countryCode: "US",
        resourceType: "foods",
        includeDetails: true,
      });

      const mappedResults = mapMfpSearchResults(searchPayload).slice(0, limit);

      span.setAttribute("http.response.status_code", searchPayload.search.status);
      span.setAttribute("app.search.detail_count", searchPayload.detailCount);
      span.setAttribute("app.search.result_count", mappedResults.length);

      logInfo("mfp.search_foods.complete", {
        query,
        limit,
        searchStatus: searchPayload.search.status,
        detailCount: searchPayload.detailCount,
        mappedCount: mappedResults.length,
        durationMs: Date.now() - startedAt,
      });

      return mappedResults;
    },
  );
}

async function executeOpenFoodFactsSearch(params: {
  query: string;
  page: number;
  pageSize: number;
}): Promise<{
  status: number;
  url: string;
  data: unknown | null;
  text: string | null;
}> {
  const startedAt = Date.now();
  const cachedSearch = await findCachedOpenFoodFactsSearch(params);

  if (cachedSearch) {
    logInfo("open_food_facts.search.cache_hit", {
      query: params.query,
      page: params.page,
      pageSize: params.pageSize,
      searchResponseId: cachedSearch.id,
      status: cachedSearch.offStatus,
      url: cachedSearch.offUrl,
      durationMs: Date.now() - startedAt,
    });
    return toOpenFoodFactsSearchPayload(cachedSearch);
  }

  const searchResponse = await searchOpenFoodFacts(params);
  await saveOpenFoodFactsSearch({
    query: params.query,
    page: params.page,
    pageSize: params.pageSize,
    offUrl: searchResponse.url,
    offStatus: searchResponse.status,
    responseJson: searchResponse.json,
    responseText: searchResponse.text,
  });

  logInfo("open_food_facts.search.fetched", {
    query: params.query,
    page: params.page,
    pageSize: params.pageSize,
    status: searchResponse.status,
    url: searchResponse.url,
    durationMs: Date.now() - startedAt,
  });

  if (searchResponse.status < 200 || searchResponse.status >= 300 || !searchResponse.json) {
    throw new Error(
      `OpenFoodFacts search failed with status ${searchResponse.status}${searchResponse.text ? `: ${summarizeText(searchResponse.text)}` : ""}`,
    );
  }

  return {
    status: searchResponse.status,
    url: searchResponse.url,
    data: searchResponse.json,
    text: searchResponse.text,
  };
}

async function searchOpenFoodFactsFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  const startedAt = Date.now();

  return Sentry.startSpan(
    {
      name: "food_search.open_food_facts",
      op: "food.search",
      attributes: {
        "app.search.query_length": query.trim().length,
        "app.search.limit": limit,
      },
    },
    async (span) => {
      logInfo("open_food_facts.search_foods.start", {
        query,
        limit,
        cacheTtlDays: config.searchCacheTtlDays,
        baseUrl: OPEN_FOOD_FACTS_BASE_URL,
      });

      const payload = await executeOpenFoodFactsSearch({
        query,
        page: 1,
        pageSize: Math.min(20, Math.max(limit * 2, 8)),
      });

      const mappedResults = mapOpenFoodFactsSearchResults(payload).slice(0, limit);

      span.setAttribute("http.response.status_code", payload.status);
      span.setAttribute("app.search.result_count", mappedResults.length);

      logInfo("open_food_facts.search_foods.complete", {
        query,
        limit,
        status: payload.status,
        mappedCount: mappedResults.length,
        durationMs: Date.now() - startedAt,
      });

      return mappedResults;
    },
  );
}

function interleaveFoodResults(sources: FoodSearchResult[][], limit: number): FoodSearchResult[] {
  const merged: FoodSearchResult[] = [];
  const seen = new Set<string>();
  const cursors = new Array(sources.length).fill(0);

  while (merged.length < limit) {
    let advanced = false;

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      const source = sources[sourceIndex];

      while (cursors[sourceIndex] < source.length) {
        const candidate = source[cursors[sourceIndex]];
        cursors[sourceIndex] += 1;
        if (seen.has(candidate.canonicalKey)) {
          continue;
        }
        seen.add(candidate.canonicalKey);
        merged.push(candidate);
        advanced = true;
        break;
      }

      if (merged.length >= limit) {
        break;
      }
    }

    if (!advanced) {
      break;
    }
  }

  return merged;
}

export async function searchUnifiedFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  return Sentry.startSpan(
    {
      name: "food_search.unified",
      op: "food.search",
      attributes: {
        "app.search.query_length": query.trim().length,
        "app.search.limit": limit,
      },
    },
    async (span) => {
      const [anmatResult, mfpResult, openFoodFactsResult] = await Promise.allSettled([
        searchLocalAnmatFoods(query, limit),
        searchMfpFoods(query, limit),
        searchOpenFoodFactsFoods(query, limit),
      ]);

      const anmatFoods = anmatResult.status === "fulfilled" ? anmatResult.value : [];
      const mfpFoods = mfpResult.status === "fulfilled" ? mfpResult.value : [];
      const openFoodFactsFoods = openFoodFactsResult.status === "fulfilled" ? openFoodFactsResult.value : [];

      if (anmatResult.status === "rejected") {
        logError("food_search.anmat_failed", anmatResult.reason, {
          query,
          limit,
        });
      }

      if (mfpResult.status === "rejected") {
        logError("food_search.mfp_failed", mfpResult.reason, {
          query,
          limit,
          anmatCount: anmatFoods.length,
        });
      }

      if (openFoodFactsResult.status === "rejected") {
        logError("food_search.open_food_facts_failed", openFoodFactsResult.reason, {
          query,
          limit,
          anmatCount: anmatFoods.length,
          mfpCount: mfpFoods.length,
        });
      }

      if (anmatResult.status === "rejected" && mfpResult.status === "rejected" && openFoodFactsResult.status === "rejected") {
        throw anmatResult.reason;
      }

      if (mfpResult.status === "rejected" || openFoodFactsResult.status === "rejected") {
        logInfo("food_search.complete_with_partial_sources", {
          query,
          limit,
          anmatCount: anmatFoods.length,
          mfpCount: mfpFoods.length,
          openFoodFactsCount: openFoodFactsFoods.length,
          mfpFailed: mfpResult.status === "rejected",
          openFoodFactsFailed: openFoodFactsResult.status === "rejected",
        });
      } else {
        logInfo("food_search.remote_sources_success", {
          query,
          limit,
          mfpCount: mfpFoods.length,
          anmatCount: anmatFoods.length,
          openFoodFactsCount: openFoodFactsFoods.length,
        });
      }

      const mergedResults = interleaveFoodResults([anmatFoods, openFoodFactsFoods, mfpFoods], limit);
      span.setAttribute("app.search.result_count", mergedResults.length);
      span.setAttribute("app.search.anmat_count", anmatFoods.length);
      span.setAttribute("app.search.mfp_count", mfpFoods.length);
      span.setAttribute("app.search.open_food_facts_count", openFoodFactsFoods.length);
      return mergedResults;
    },
  );
}

async function searchFoodsBySource(
  source: SearchSource,
  query: string,
  limit: number,
): Promise<FoodSearchResult[]> {
  if (source === "anmat") {
    return searchLocalAnmatFoods(query, limit);
  }

  if (source === "openfoodfacts") {
    return searchOpenFoodFactsFoods(query, limit);
  }

  return searchMfpFoods(query, limit);
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export async function handleSearchRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  const query = (url.searchParams.get("query") ?? "").trim();
  if (!query) {
    return json({ error: "query is required" }, 400);
  }

  const maxItems = Math.max(1, Math.min(100, parseInteger(url.searchParams.get("maxItems"), 20)));
  const provider = parseSearchSource(url.searchParams.get("provider"));

  try {
    const foods = provider
      ? await searchFoodsBySource(provider, query, maxItems)
      : await searchUnifiedFoods(query, maxItems);
    return json({
      query,
      provider,
      foods,
    });
  } catch (error) {
    return reportUnknownError("search_failed", error);
  }
}

export async function handleMfpSessionRefreshRequest(): Promise<Response> {
  try {
    const auth = await getMfpAuthHeaders({ forceRefresh: true });
    return json({
      ok: true,
      refreshed: true,
      hasAuthorization: Boolean(auth.authorization),
      hasCookie: Boolean(auth.cookieHeader),
    });
  } catch (error) {
    return reportUnknownError("mfp_session_refresh_failed", error);
  }
}

export async function handleAnmatLiveSearchRequest(request: Request): Promise<Response> {
  const body = await parseJsonBody(request);
  const query = asString(body?.query)?.trim() ?? "";
  const maxItems = Math.max(1, Math.min(20, Math.round(asNumber(body?.maxItems) ?? 8)));

  if (query.length < 2) {
    return json({ error: "query is required" }, 400);
  }

  try {
    const queuedSearch = await enqueueAnmatLiveSearch(query);
    logInfo("anmat_live_search.queued", {
      query,
      maxItems,
      searchRequestId: queuedSearch.id,
      queuedAt: queuedSearch.createdAt.toISOString(),
    });

    return json({
      query,
      foods: [],
      queued: true,
      searchRequestId: queuedSearch.id,
      queuedAt: queuedSearch.createdAt.toISOString(),
    });
  } catch (error) {
    return reportUnknownError("anmat_live_search_failed", error);
  }
}
