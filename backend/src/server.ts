import { and, desc, eq, ilike, or } from "drizzle-orm";
import {
  buildRecentLogContextPrompt,
  buildRecentLogTranscriptionPrompt,
  parseRecentLogHints,
} from "./ai-log-context";
import {
  buildDetailContentUrl,
  buildDetailWrapperUrl,
  createSessionCookie,
  extractDetailToken,
  fetchSearchXml,
  fetchText as fetchAnmatText,
  parseProductsFromHtml,
  parseSearchResponse,
  type Product as AnmatProduct,
} from "./anmat-client";
import {
  compressHtmlWithZstd,
  extractProductMetadataFromHtml,
  htmlToText,
  normalizeTextValue,
  parseNutritionFromHtml,
  sha256Hex,
} from "./anmat-html";
import { config } from "./config";
import { db } from "./db";
import {
  anmatProductDerivedData,
  anmatProductHtmlBlobs,
  mfpFoodDetailResponses,
  mfpSearchResponses,
} from "./db/schema";
import { logError, logInfo, redactSecret, summarizeText } from "./logging";
import { fetchFoodDetail, searchNutrition } from "./mfp-client";

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

type SearchSource = "mfp" | "anmat";

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
  sourceLabel: "MFP" | "ANMAT";
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: FoodNutrition;
};

type SearchResultFood = FoodSearchResult & {
  resultId: string;
};

type OpenRouterToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type OpenRouterMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

type Meal = "breakfast" | "lunch" | "dinner" | "snacks";

type ApprovalOutput = {
  approved: boolean;
  reason?: string;
};

type ResolvedApprovalSuggestion = {
  suggestionId: string;
  resultId: string;
  meal: Meal;
  portion: number;
  reason: string;
  food: SearchResultFood;
  output?: ApprovalOutput;
};

type AgentEvent =
  | {
      kind: "assistant";
      text: string;
    }
  | {
      kind: "search";
      foods: SearchResultFood[];
    }
  | {
      kind: "approval";
      toolCallId: string;
      suggestions: ResolvedApprovalSuggestion[];
    };

type AgentStatus = "ready" | "awaiting-approval";

type AgentSession = {
  id: string;
  userId: string;
  conversation: OpenRouterMessage[];
  transcriptionPrompt: string | null;
  searchResultCounter: number;
  searchResultsByLocalId: Map<string, SearchResultFood>;
  pendingApprovals: Map<string, ResolvedApprovalSuggestion[]>;
  updatedAt: number;
};

function buildMfpSearchTraceId(): string {
  return `mfp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function countSearchItems(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items.length : null;
}

const openRouterTools = [
  {
    type: "function",
    function: {
      name: "searchFoods",
      description: "Search foods in the app food database.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "User query for food search.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Max number of foods to return.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "requestFoodApprovals",
      description:
        "Request user approval for one or more selected food entries using local result IDs from searchFoods.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              properties: {
                resultId: { type: "string" },
                meal: {
                  type: "string",
                  enum: ["breakfast", "lunch", "dinner", "snacks"],
                },
                portion: { type: "number", minimum: 0.25 },
                reason: { type: "string" },
              },
              required: ["resultId", "meal", "portion", "reason"],
            },
          },
        },
        required: ["suggestions"],
      },
    },
  },
] as const;

const systemPrompt = [
  "You are Caloric's food logging assistant.",
  "Always call searchFoods before suggesting a food entry.",
  "searchFoods returns local result IDs. Only reference those IDs later.",
  "Never send or edit nutrition/name/brand/serving in approval requests.",
  "When ready, call requestFoodApprovals once with one or more suggestions.",
  "Only set resultId, meal, portion, and reason in each suggestion.",
  "Portion should be in quarter increments (0.25).",
  "If the user rejects suggestions, explain briefly and search again.",
].join(" ");

const aiSessions = new Map<string, AgentSession>();
const maxAiSessionIdleMs = 1000 * 60 * 60 * 8;

function json(data: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
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

async function findCachedSearch(params: {
  query: string;
  offset: number;
  maxItems: number;
  countryCode: string;
  resourceType: string;
}): Promise<StoredSearchResponse | null> {
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
      ),
    )
    .orderBy(desc(mfpSearchResponses.createdAt), desc(mfpSearchResponses.id))
    .limit(1);

  return cachedSearch ?? null;
}

async function findCachedDetail(foodId: string, version: string): Promise<StoredDetailResponse | null> {
  const [cachedDetail] = await db
    .select({
      mfpStatus: mfpFoodDetailResponses.mfpStatus,
      mfpUrl: mfpFoodDetailResponses.mfpUrl,
      responseJson: mfpFoodDetailResponses.responseJson,
      responseText: mfpFoodDetailResponses.responseText,
    })
    .from(mfpFoodDetailResponses)
    .where(and(eq(mfpFoodDetailResponses.foodId, foodId), eq(mfpFoodDetailResponses.version, version)))
    .orderBy(desc(mfpFoodDetailResponses.createdAt), desc(mfpFoodDetailResponses.id))
    .limit(1);

  return cachedDetail ?? null;
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
      const fallbackUrl = `${config.mfpBaseUrl}/api/services/foods/${key.foodId}?version=${key.version}`;

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
    .orderBy(desc(anmatProductHtmlBlobs.importedAt), desc(anmatProductHtmlBlobs.id))
    .limit(Math.max(limit * 8, 64));

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

  return [...deduped.values()]
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
}

async function searchMfpFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  const startedAt = Date.now();
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

  logInfo("mfp.search_foods.complete", {
    query,
    limit,
    searchStatus: searchPayload.search.status,
    detailCount: searchPayload.detailCount,
    mappedCount: mappedResults.length,
    durationMs: Date.now() - startedAt,
  });

  return mappedResults;
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

async function searchUnifiedFoods(query: string, limit: number): Promise<FoodSearchResult[]> {
  const [anmatResult, mfpResult] = await Promise.allSettled([
    searchLocalAnmatFoods(query, limit),
    searchMfpFoods(query, limit),
  ]);

  const anmatFoods = anmatResult.status === "fulfilled" ? anmatResult.value : [];
  const mfpFoods = mfpResult.status === "fulfilled" ? mfpResult.value : [];

  if (anmatFoods.length === 0 && mfpFoods.length === 0) {
    if (anmatResult.status === "rejected") {
      logError("food_search.anmat_failed", anmatResult.reason, {
        query,
        limit,
      });
      throw anmatResult.reason;
    }
    if (mfpResult.status === "rejected") {
      logError("food_search.mfp_failed", mfpResult.reason, {
        query,
        limit,
      });
      throw mfpResult.reason;
    }
  }

  if (mfpResult.status === "rejected") {
    logError("food_search.mfp_partial_failure", mfpResult.reason, {
      query,
      limit,
      anmatCount: anmatFoods.length,
    });
  } else {
    logInfo("food_search.mfp_success", {
      query,
      limit,
      mfpCount: mfpFoods.length,
      anmatCount: anmatFoods.length,
    });
  }

  return interleaveFoodResults([anmatFoods, mfpFoods], limit);
}

function buildLiveSourcePath(product: AnmatProduct, detailKey: string | null, htmlSha256: string): string {
  const stableKey = detailKey || normalizeTextValue(product.rnpa) || htmlSha256.slice(0, 16);
  return `live-search/${product.searchMode}/${stableKey}.html`;
}

async function cacheLiveAnmatProduct(
  query: string,
  cookie: string,
  product: AnmatProduct,
  page: number,
): Promise<FoodSearchResult | null> {
  const wrapperUrl = buildDetailWrapperUrl(product.detailUrl);
  const contentUrl = buildDetailContentUrl(product.detailUrl);

  if (!contentUrl) {
    return null;
  }

  const response = await fetchAnmatText(contentUrl, config.requestTimeoutMs, {
    cookie,
    referer: wrapperUrl ?? contentUrl,
  });
  const html = response.text;
  const htmlBytes = new TextEncoder().encode(html);
  const htmlText = htmlToText(html);
  const metadata = extractProductMetadataFromHtml(htmlText, {
    searchMode: product.searchMode,
    province: product.province,
    rnpa: product.rnpa,
    denominacion: product.denominacion,
    nombreFantasia: product.nombreFantasia,
    marca: product.marca,
    titular: product.titular,
    estado: product.estado,
  });
  const detailKey = normalizeTextValue(extractDetailToken(product.detailUrl));
  const compressed = await compressHtmlWithZstd(html);
  const htmlSha256 = sha256Hex(htmlBytes);
  const now = new Date();

  const [savedBlob] = await db
    .insert(anmatProductHtmlBlobs)
    .values({
      sourcePath: buildLiveSourcePath(product, detailKey, htmlSha256),
      ingestSource: "live_search",
      runKey: "live-cache",
      detailKey,
      token: detailKey,
      query,
      queryIndex: null,
      page,
      wrapperUrl: normalizeTextValue(wrapperUrl),
      contentUrl: normalizeTextValue(response.url),
      searchMode: metadata.searchMode ?? normalizeTextValue(product.searchMode),
      province: metadata.province,
      rnpa: metadata.rnpa,
      denominacion: metadata.denominacion,
      nombreFantasia: metadata.nombreFantasia,
      marca: metadata.marca,
      titular: metadata.titular,
      estado: metadata.estado,
      compressionAlgo: "zstd",
      htmlZstd: compressed,
      htmlSha256,
      uncompressedBytes: htmlBytes.byteLength,
      compressedBytes: compressed.byteLength,
      savedAt: now,
    })
    .onConflictDoUpdate({
      target: anmatProductHtmlBlobs.sourcePath,
      set: {
        ingestSource: "live_search",
        runKey: "live-cache",
        detailKey,
        token: detailKey,
        query,
        queryIndex: null,
        page,
        wrapperUrl: normalizeTextValue(wrapperUrl),
        contentUrl: normalizeTextValue(response.url),
        searchMode: metadata.searchMode ?? normalizeTextValue(product.searchMode),
        province: metadata.province,
        rnpa: metadata.rnpa,
        denominacion: metadata.denominacion,
        nombreFantasia: metadata.nombreFantasia,
        marca: metadata.marca,
        titular: metadata.titular,
        estado: metadata.estado,
        compressionAlgo: "zstd",
        htmlZstd: compressed,
        htmlSha256,
        uncompressedBytes: htmlBytes.byteLength,
        compressedBytes: compressed.byteLength,
        savedAt: now,
        importedAt: now,
      },
    })
    .returning({
      id: anmatProductHtmlBlobs.id,
      detailKey: anmatProductHtmlBlobs.detailKey,
      rnpa: anmatProductHtmlBlobs.rnpa,
      denominacion: anmatProductHtmlBlobs.denominacion,
      nombreFantasia: anmatProductHtmlBlobs.nombreFantasia,
      marca: anmatProductHtmlBlobs.marca,
    });

  const nutrition = parseNutritionFromHtml(html);

  await db
    .insert(anmatProductDerivedData)
    .values({
      htmlBlobId: savedBlob.id,
      nutritionFound: nutrition.nutritionFound,
      servingText: nutrition.servingText,
      servingQuantity: nutrition.servingQuantity,
      servingUnit: nutrition.servingUnit,
      calories: nutrition.calories,
      proteinGrams: nutrition.proteinGrams,
      carbsGrams: nutrition.carbsGrams,
      fatGrams: nutrition.fatGrams,
      fiberGrams: nutrition.fiberGrams,
      sugarsGrams: nutrition.sugarsGrams,
      sodiumMg: nutrition.sodiumMg,
      eanAttempted: false,
      eanStatus: "not_attempted_live_pdf_skipped",
      ean: null,
      eanSource: null,
      eanCandidates: null,
    })
    .onConflictDoUpdate({
      target: anmatProductDerivedData.htmlBlobId,
      set: {
        nutritionFound: nutrition.nutritionFound,
        servingText: nutrition.servingText,
        servingQuantity: nutrition.servingQuantity,
        servingUnit: nutrition.servingUnit,
        calories: nutrition.calories,
        proteinGrams: nutrition.proteinGrams,
        carbsGrams: nutrition.carbsGrams,
        fatGrams: nutrition.fatGrams,
        fiberGrams: nutrition.fiberGrams,
        sugarsGrams: nutrition.sugarsGrams,
        sodiumMg: nutrition.sodiumMg,
        eanAttempted: false,
        eanStatus: "not_attempted_live_pdf_skipped",
        ean: null,
        eanSource: null,
        eanCandidates: null,
        parsedAt: now,
      },
    });

  return mapAnmatRowToFood({
    htmlBlobId: savedBlob.id,
    detailKey: savedBlob.detailKey,
    rnpa: savedBlob.rnpa,
    denominacion: savedBlob.denominacion,
    nombreFantasia: savedBlob.nombreFantasia,
    marca: savedBlob.marca,
    servingText: nutrition.servingText,
    servingQuantity: nutrition.servingQuantity,
    servingUnit: nutrition.servingUnit,
    calories: nutrition.calories,
    proteinGrams: nutrition.proteinGrams,
    carbsGrams: nutrition.carbsGrams,
    fatGrams: nutrition.fatGrams,
    fiberGrams: nutrition.fiberGrams,
    sugarsGrams: nutrition.sugarsGrams,
    sodiumMg: nutrition.sodiumMg,
  });
}

async function fetchLiveAnmatFoodsAndCache(query: string, limit: number): Promise<FoodSearchResult[]> {
  const cookie = await createSessionCookie(config.requestTimeoutMs);
  const candidateMap = new Map<string, { product: AnmatProduct; page: number }>();
  const searches = [
    { denominacion: query, fantasia: "", marca: "" },
    { denominacion: "", fantasia: query, marca: "" },
    { denominacion: "", fantasia: "", marca: query },
  ];

  for (const search of searches) {
    const xml = await fetchSearchXml(
      cookie,
      {
        ...search,
        mode: "informacionNutricional",
      },
      1,
      config.requestTimeoutMs,
    );
    const parsed = parseSearchResponse(xml.text);
    const products = parseProductsFromHtml(parsed.resultsHtml, "informacionNutricional");

    for (const product of products) {
      if (!product.detailUrl) {
        continue;
      }

      const key =
        extractDetailToken(product.detailUrl) ||
        `${normalizeTextValue(product.rnpa) || ""}|${normalizeTextValue(product.marca) || ""}|${normalizeTextValue(product.denominacion) || ""}`;

      if (!candidateMap.has(key)) {
        candidateMap.set(key, { product, page: 1 });
      }

      if (candidateMap.size >= Math.max(limit * 2, 8)) {
        break;
      }
    }

    if (candidateMap.size >= Math.max(limit * 2, 8)) {
      break;
    }
  }

  const tasks = [...candidateMap.values()]
    .slice(0, limit)
    .map(({ product, page }) => async () => cacheLiveAnmatProduct(query, cookie, product, page));

  const results = await runWithConcurrency(tasks, 3);
  const foods: FoodSearchResult[] = [];
  const seen = new Set<string>();

  for (const food of results) {
    if (!food || seen.has(food.canonicalKey)) {
      continue;
    }
    seen.add(food.canonicalKey);
    foods.push(food);
  }

  return foods;
}

function normalizeMeal(meal: unknown): Meal {
  const normalized = typeof meal === "string" ? meal.trim().toLowerCase() : "";
  if (
    normalized === "breakfast" ||
    normalized === "lunch" ||
    normalized === "dinner" ||
    normalized === "snacks"
  ) {
    return normalized;
  }
  return "lunch";
}

function sanitizePortion(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === undefined) {
    return 1;
  }

  const bounded = Math.max(0.25, parsed);
  return Math.round(bounded * 4) / 4;
}

function parseToolArguments(raw: string): unknown {
  if (!raw || !raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

function createMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeOpenRouterUserId(userId: string): string {
  return userId.slice(0, 128);
}

function pruneOldAiSessions(now = Date.now()) {
  for (const [sessionId, session] of aiSessions) {
    if (now - session.updatedAt > maxAiSessionIdleMs) {
      aiSessions.delete(sessionId);
    }
  }
}

function requireSessionOwner(sessionId: string, userId: string): AgentSession | null {
  const session = aiSessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.userId !== userId) {
    return null;
  }

  return session;
}

function parseOpenRouterText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        if (!record) {
          return "";
        }

        const text = record.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }

  return "";
}

function parseOpenRouterToolCalls(raw: unknown): OpenRouterToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const output: OpenRouterToolCall[] = [];

  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (!record) {
      continue;
    }

    const id = asString(record.id);
    const type = record.type;
    const fn = asRecord(record.function);
    const name = asString(fn?.name);

    if (!id || type !== "function" || !name) {
      continue;
    }

    const fnArgsRaw = fn?.arguments;
    let args = "";
    if (typeof fnArgsRaw === "string") {
      args = fnArgsRaw;
    } else if (fnArgsRaw !== undefined) {
      try {
        args = JSON.stringify(fnArgsRaw);
      } catch {
        args = "";
      }
    }

    output.push({
      id,
      type: "function",
      function: {
        name,
        arguments: args,
      },
    });
  }

  return output;
}

async function requestOpenRouterTurn(session: AgentSession): Promise<{
  assistantText: string;
  toolCalls: OpenRouterToolCall[];
}> {
  const providerOnly = config.openRouterProviderOnly.trim();
  const requestBody: Record<string, unknown> = {
    model: config.openRouterModel,
    stream: false,
    tool_choice: "auto",
    tools: openRouterTools,
    messages: session.conversation,
    user: normalizeOpenRouterUserId(session.userId),
    session_id: session.id,
  };

  if (providerOnly) {
    requestBody.provider = {
      only: [providerOnly],
      allow_fallbacks: false,
    };
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const textBody = await response.text();

  if (!response.ok) {
    const suffix = textBody ? `: ${textBody.slice(0, 300)}` : "";
    throw new Error(`OpenRouter request failed (${response.status})${suffix}`);
  }

  let parsed: unknown;
  try {
    parsed = textBody ? JSON.parse(textBody) : {};
  } catch {
    throw new Error("OpenRouter returned invalid JSON.");
  }

  const root = asRecord(parsed);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);

  const assistantText = parseOpenRouterText(message?.content);
  const toolCalls = parseOpenRouterToolCalls(message?.tool_calls);

  return {
    assistantText,
    toolCalls,
  };
}

async function runToolCall(
  session: AgentSession,
  toolCall: OpenRouterToolCall,
): Promise<{ pauseForApproval: boolean; output: unknown; events: AgentEvent[] }> {
  let rawArguments: unknown;
  try {
    rawArguments = parseToolArguments(toolCall.function.arguments);
  } catch {
    return {
      pauseForApproval: false,
      output: {
        error: "Tool arguments were invalid JSON.",
      },
      events: [],
    };
  }

  if (toolCall.function.name === "searchFoods") {
    const args = asRecord(rawArguments);
    const query = asString(args?.query) ?? "";
    const parsedLimit = asNumber(args?.limit);
    const limit = Math.max(1, Math.min(10, Number.isFinite(parsedLimit) ? Math.round(parsedLimit as number) : 6));

    if (query.trim().length < 2) {
      return {
        pauseForApproval: false,
        output: {
          error: "Invalid searchFoods input.",
        },
        events: [],
      };
    }

    const topFoods = await searchUnifiedFoods(query.trim(), limit);
    const foodsWithResultIds: SearchResultFood[] = topFoods.map((food) => {
      const resultId = `r${session.searchResultCounter}`;
      session.searchResultCounter += 1;

      const mapped: SearchResultFood = {
        ...food,
        resultId,
      };

      session.searchResultsByLocalId.set(resultId, mapped);
      return mapped;
    });

    return {
      pauseForApproval: false,
      output: {
        foods: foodsWithResultIds,
      },
      events: [
        {
          kind: "search",
          foods: foodsWithResultIds,
        },
      ],
    };
  }

  if (toolCall.function.name === "requestFoodApprovals") {
    const args = asRecord(rawArguments);
    const suggestionsRaw = args?.suggestions;

    if (!Array.isArray(suggestionsRaw) || suggestionsRaw.length === 0 || suggestionsRaw.length > 8) {
      return {
        pauseForApproval: false,
        output: {
          error: "Invalid requestFoodApprovals input.",
        },
        events: [],
      };
    }

    const resolvedSuggestions: ResolvedApprovalSuggestion[] = [];
    const unknownResultIds: string[] = [];
    const seenSuggestions = new Set<string>();

    for (const candidate of suggestionsRaw) {
      const suggestion = asRecord(candidate);
      const resultId = asString(suggestion?.resultId)?.trim() ?? "";
      const food = session.searchResultsByLocalId.get(resultId);
      if (!food) {
        unknownResultIds.push(resultId || "(empty)");
        continue;
      }

      const meal = normalizeMeal(suggestion?.meal);
      const portion = sanitizePortion(suggestion?.portion);
      const reason = asString(suggestion?.reason)?.trim() ?? "";
      if (!reason) {
        continue;
      }

      const duplicateKey = `${resultId}|${meal}|${portion}`;
      if (seenSuggestions.has(duplicateKey)) {
        continue;
      }
      seenSuggestions.add(duplicateKey);

      resolvedSuggestions.push({
        suggestionId: createMessageId(),
        resultId,
        meal,
        portion,
        reason,
        food,
      });
    }

    if (unknownResultIds.length > 0) {
      return {
        pauseForApproval: false,
        output: {
          error: `Unknown result IDs: ${unknownResultIds.slice(0, 5).join(", ")}`,
        },
        events: [],
      };
    }

    if (resolvedSuggestions.length === 0) {
      return {
        pauseForApproval: false,
        output: {
          error: "No valid suggestions to approve.",
        },
        events: [],
      };
    }

    session.pendingApprovals.set(toolCall.id, resolvedSuggestions);

    return {
      pauseForApproval: true,
      output: null,
      events: [
        {
          kind: "approval",
          toolCallId: toolCall.id,
          suggestions: resolvedSuggestions,
        },
      ],
    };
  }

  return {
    pauseForApproval: false,
    output: {
      error: `Unknown tool: ${toolCall.function.name}`,
    },
    events: [],
  };
}

async function runAssistantLoop(session: AgentSession): Promise<{ status: AgentStatus; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];

  for (let step = 0; step < 8; step += 1) {
    const turn = await requestOpenRouterTurn(session);

    if (turn.assistantText.trim()) {
      events.push({
        kind: "assistant",
        text: turn.assistantText,
      });
    }

    session.conversation.push({
      role: "assistant",
      content: turn.assistantText.trim() ? turn.assistantText : null,
      ...(turn.toolCalls.length > 0 ? { tool_calls: turn.toolCalls } : {}),
    });

    if (turn.toolCalls.length === 0) {
      return {
        status: "ready",
        events,
      };
    }

    for (const toolCall of turn.toolCalls) {
      const toolResult = await runToolCall(session, toolCall);
      events.push(...toolResult.events);

      if (toolResult.pauseForApproval) {
        return {
          status: "awaiting-approval",
          events,
        };
      }

      session.conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(toolResult.output ?? {}),
      });
    }
  }

  return {
    status: "ready",
    events,
  };
}

async function transcribeAudioSnippet(audioFile: File, prompt?: string | null): Promise<string> {
  if (!config.groqApiKey) {
    throw new Error("GROQ_API_KEY is not configured on the backend.");
  }

  if (audioFile.size <= 0) {
    throw new Error("Audio snippet was empty.");
  }

  if (audioFile.size > 12 * 1024 * 1024) {
    throw new Error("Audio snippet is too large (max 12 MB).");
  }

  const guessedExtension = (audioFile.type || "audio/m4a").split("/").at(1) ?? "m4a";
  const fileName = audioFile.name?.trim() || `voice.${guessedExtension}`;
  const formData = new FormData();
  formData.set("model", "whisper-large-v3-turbo");
  formData.set("response_format", "json");
  formData.set("temperature", "0");
  if (prompt && prompt.trim()) {
    formData.set("prompt", prompt.trim());
  }
  formData.set("file", audioFile, fileName);

  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
      },
      body: formData,
    });

    const rawBody = await response.text();

    if (!response.ok) {
      let errorMessage = rawBody;
      try {
        const parsedError = JSON.parse(rawBody) as { error?: { message?: unknown } };
        if (typeof parsedError.error?.message === "string" && parsedError.error.message.trim()) {
          errorMessage = parsedError.error.message;
        }
      } catch {
        // Keep raw text fallback if Groq returns non-JSON.
      }

      throw new Error(`Groq returned ${response.status}: ${errorMessage}`);
    }

    let transcript = rawBody.trim();
    try {
      const parsed = JSON.parse(rawBody) as { text?: unknown };
      if (typeof parsed.text === "string") {
        transcript = parsed.text.trim();
      }
    } catch {
      // Keep plain text response fallback.
    }

    if (!transcript) {
      throw new Error("Groq returned an empty transcription.");
    }

    return transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Groq transcription request failed: ${message}`);
  }
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await request.json();
    return asRecord(parsed);
  } catch {
    return null;
  }
}

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/search") {
      if (request.method !== "GET") {
        return json({ error: "Method not allowed" }, 405);
      }

      const query = (url.searchParams.get("query") ?? "").trim();
      if (!query) {
        return json({ error: "query is required" }, 400);
      }

      const maxItems = Math.max(1, Math.min(100, parseInteger(url.searchParams.get("maxItems"), 20)));

      try {
        const foods = await searchUnifiedFoods(query, maxItems);
        return json({
          query,
          foods,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: "search_failed", message }, 502);
      }
    }

    if (url.pathname === "/search/anmat-live") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      const body = await parseJsonBody(request);
      const query = asString(body?.query)?.trim() ?? "";
      const maxItems = Math.max(1, Math.min(20, Math.round(asNumber(body?.maxItems) ?? 8)));

      if (query.length < 2) {
        return json({ error: "query is required" }, 400);
      }

      try {
        const foods = await fetchLiveAnmatFoodsAndCache(query, maxItems);
        return json({
          query,
          foods,
          eanAttempted: false,
          eanStatus: "not_attempted_live_pdf_skipped",
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: "anmat_live_search_failed", message }, 502);
      }
    }

    if (url.pathname === "/ai/session") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      const body = await parseJsonBody(request);
      const userId = asString(body?.userId)?.trim() ?? "";

      if (!userId) {
        return json({ error: "userId is required" }, 400);
      }

      pruneOldAiSessions();
      const recentLogHints = parseRecentLogHints(body?.recentLogs);
      const recentLogContextPrompt = buildRecentLogContextPrompt(recentLogHints);
      const transcriptionPrompt = buildRecentLogTranscriptionPrompt(recentLogHints);

      const sessionId = crypto.randomUUID();
      const now = Date.now();
      aiSessions.set(sessionId, {
        id: sessionId,
        userId,
        conversation: [
          {
            role: "system",
            content: systemPrompt,
          },
          ...(recentLogContextPrompt
            ? [
                {
                  role: "system" as const,
                  content: recentLogContextPrompt,
                },
              ]
            : []),
        ],
        transcriptionPrompt,
        searchResultCounter: 1,
        searchResultsByLocalId: new Map<string, SearchResultFood>(),
        pendingApprovals: new Map<string, ResolvedApprovalSuggestion[]>(),
        updatedAt: now,
      });

      return json({
        sessionId,
        status: "ready",
      });
    }

    if (url.pathname === "/ai/turn") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      let sessionId = "";
      let userId = "";
      let action: Record<string, unknown> | null = null;
      let audioFile: File | null = null;

      const contentType = request.headers.get("content-type") ?? "";

      if (contentType.includes("multipart/form-data")) {
        let formData: FormData;
        try {
          formData = await request.formData();
        } catch {
          return json({ error: "Invalid multipart body" }, 400);
        }

        sessionId = asString(formData.get("sessionId"))?.trim() ?? "";
        userId = asString(formData.get("userId"))?.trim() ?? "";

        const actionType = asString(formData.get("actionType"))?.trim() ?? "";
        if (!actionType) {
          return json({ error: "actionType is required" }, 400);
        }

        if (actionType === "user-message") {
          const message = asString(formData.get("message"))?.trim();
          action = {
            type: "user-message",
            ...(message ? { message } : {}),
          };

          const audioField = formData.get("audio");
          if (audioField instanceof File && audioField.size > 0) {
            audioFile = audioField;
          }
        } else if (actionType === "approval") {
          action = {
            type: "approval",
            toolCallId: asString(formData.get("toolCallId")) ?? "",
            suggestionId: asString(formData.get("suggestionId")) ?? "",
            approved: formData.get("approved") === "true",
          };
        } else {
          action = {
            type: actionType,
          };
        }
      } else {
        const body = await parseJsonBody(request);
        sessionId = asString(body?.sessionId)?.trim() ?? "";
        userId = asString(body?.userId)?.trim() ?? "";
        action = asRecord(body?.action);
      }

      if (!action) {
        return json({ error: "action is required" }, 400);
      }

      const actionType = asString(action.type)?.trim() ?? "";

      if (!sessionId || !userId) {
        return json({ error: "sessionId and userId are required" }, 400);
      }

      if (!actionType) {
        return json({ error: "action.type is required" }, 400);
      }

      pruneOldAiSessions();
      const session = requireSessionOwner(sessionId, userId);
      if (!session) {
        return json({ error: "Session not found for this user" }, 403);
      }

      session.updatedAt = Date.now();

      try {
        if (actionType === "user-message") {
          let message = asString(action.message)?.trim() ?? "";
          if (!message && audioFile) {
            message = await transcribeAudioSnippet(audioFile, session.transcriptionPrompt);
          }

          if (!message) {
            return json({ error: "action.message or audio is required" }, 400);
          }

          if (session.pendingApprovals.size > 0) {
            return json({ error: "Resolve pending approvals before sending a new message." }, 409);
          }

          session.conversation.push({
            role: "user",
            content: message,
          });

          const loopResult = await runAssistantLoop(session);
          session.updatedAt = Date.now();

          return json({
            status: loopResult.status,
            events: loopResult.events,
            resolvedUserMessage: message,
          });
        }

        if (actionType === "approval") {
          const toolCallId = asString(action.toolCallId)?.trim() ?? "";
          const suggestionId = asString(action.suggestionId)?.trim() ?? "";
          const approved = action.approved === true;

          if (!toolCallId || !suggestionId) {
            return json({ error: "action.toolCallId and action.suggestionId are required" }, 400);
          }

          const pendingSuggestions = session.pendingApprovals.get(toolCallId);
          if (!pendingSuggestions) {
            return json({ error: "No pending approval request for tool call." }, 409);
          }

          const targetIndex = pendingSuggestions.findIndex(
            (suggestion) => suggestion.suggestionId === suggestionId,
          );
          if (targetIndex === -1) {
            return json({ error: "Suggestion not found." }, 404);
          }

          if (pendingSuggestions[targetIndex]?.output) {
            return json({
              status: "awaiting-approval",
              events: [],
            });
          }

          const itemOutput: ApprovalOutput = {
            approved,
            reason: approved ? undefined : "User rejected this suggestion.",
          };

          const nextSuggestions = pendingSuggestions.map((suggestion, index) =>
            index === targetIndex
              ? {
                  ...suggestion,
                  output: itemOutput,
                }
              : suggestion,
          );

          const allResolved = nextSuggestions.every((suggestion) => Boolean(suggestion.output));

          if (!allResolved) {
            session.pendingApprovals.set(toolCallId, nextSuggestions);
            session.updatedAt = Date.now();
            return json({
              status: "awaiting-approval",
              events: [],
            });
          }

          session.pendingApprovals.delete(toolCallId);
          session.conversation.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: JSON.stringify({
              decisions: nextSuggestions.map((suggestion) => ({
                suggestionId: suggestion.suggestionId,
                resultId: suggestion.resultId,
                meal: suggestion.meal,
                portion: suggestion.portion,
                approved: suggestion.output?.approved ?? false,
                reason: suggestion.output?.reason,
              })),
            }),
          });

          const loopResult = await runAssistantLoop(session);
          session.updatedAt = Date.now();

          return json({
            status: loopResult.status,
            events: loopResult.events,
          });
        }

        return json({ error: `Unsupported action type: ${actionType}` }, 400);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: "ai_turn_failed", message }, 502);
      }
    }

    return json({ error: "Not found" }, 404);
  },
});

logInfo("backend.startup", {
  host: server.hostname,
  port: server.port,
  mfpBaseUrl: config.mfpBaseUrl,
  hasMfpAuthorization: Boolean(config.mfpAuthorization),
  mfpAuthorizationPreview: redactSecret(config.mfpAuthorization),
  hasMfpCookie: Boolean(config.mfpCookie),
  mfpCookiePreview: redactSecret(config.mfpCookie),
  mfpDetailConcurrency: config.detailConcurrency,
  mfpRequestTimeoutMs: config.requestTimeoutMs,
});
console.log(`backend listening on http://${server.hostname}:${server.port}`);
