import { getMfpNetCarbs } from "../providers/myfitnesspal/nutrition.ts";
import type { FoodNutrition, FoodSearchResult } from "./FoodSearch.ts";

// Pure mapping and ranking for provider payloads. Provider JSON is loosely
// typed (numbers arrive as strings, fields go missing), and cached rows hold
// whatever the provider returned, so fields are coerced one by one and bad
// items are skipped rather than failing the whole response.

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const asString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

export const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

// Drops undefined values: JSON.stringify did this implicitly in backend/, and
// the response schemas use exact optional keys.
export const compact = <A extends object>(value: A): A =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as A;

const compactNutrition = (nutrition: FoodNutrition): FoodNutrition | undefined => {
  const result = compact(nutrition);
  return Object.keys(result).length > 0 ? result : undefined;
};

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

export const countSearchItems = (payload: unknown): number | undefined => {
  const items = asRecord(payload)?.items;
  return Array.isArray(items) ? items.length : undefined;
};

// --- MyFitnessPal ------------------------------------------------------------

export interface DetailKey {
  readonly foodId: string;
  readonly version: string;
}

export interface MfpDetailPayload extends DetailKey {
  readonly status: number;
  readonly data: unknown | null;
}

export const extractDetailKeys = (searchJson: unknown): ReadonlyArray<DetailKey> => {
  const keys: Array<DetailKey> = [];
  const seen = new Set<string>();
  for (const row of asArray(asRecord(searchJson)?.items)) {
    const item = asRecord(asRecord(row)?.item);
    const id = item?.id;
    const version = item?.version;
    if (id === undefined || id === null || version === undefined || version === null) {
      continue;
    }
    const key = { foodId: String(id), version: String(version) };
    const unique = `${key.foodId}:${key.version}`;
    if (!seen.has(unique)) {
      seen.add(unique);
      keys.push(key);
    }
  }
  return keys;
};

const formatServing = (servingSizes: unknown): string | undefined => {
  for (const candidate of asArray(servingSizes)) {
    const serving = asRecord(candidate);
    if (!serving) {
      continue;
    }
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
};

const mapMfpNutrition = (value: unknown): FoodNutrition | undefined => {
  const contents = asRecord(value);
  if (!contents) {
    return undefined;
  }
  const fiber = asNumber(contents.fiber);
  return compactNutrition({
    calories: asNumber(asRecord(contents.energy)?.value),
    protein: asNumber(contents.protein),
    carbs: getMfpNetCarbs(asNumber(contents.carbohydrates), fiber, asNumber(contents.net_carbs)),
    fat: asNumber(contents.fat),
    fiber,
    sugars: asNumber(contents.sugar),
    sodiumMg: asNumber(contents.sodium),
    potassiumMg: asNumber(contents.potassium),
  });
};

// Search items carry a summary; detail responses (when fetched) are preferred.
// Items without any nutrition are dropped.
export const mapMfpSearchResults = (
  searchJson: unknown,
  details: ReadonlyArray<MfpDetailPayload>,
): Array<FoodSearchResult> => {
  const detailById = new Map<string, Record<string, unknown>>();
  for (const detail of details) {
    const data = asRecord(detail.data);
    if (detail.status === 200 && data) {
      detailById.set(`${detail.foodId}:${detail.version}`, data);
    }
  }

  const results: Array<FoodSearchResult> = [];
  const seen = new Set<string>();
  for (const row of asArray(asRecord(searchJson)?.items)) {
    const item = asRecord(asRecord(row)?.item);
    const foodId = asString(item?.id);
    const version = asString(item?.version);
    if (!item || !foodId || !version) {
      continue;
    }
    const compositeId = `${foodId}:${version}`;
    if (seen.has(compositeId)) {
      continue;
    }
    seen.add(compositeId);

    const source = detailById.get(compositeId) ?? item;
    const name = asString(source.description) ?? asString(item.description);
    if (!name) {
      continue;
    }
    const nutrition = mapMfpNutrition(source.nutritional_contents ?? item.nutritional_contents);
    if (!nutrition) {
      continue;
    }
    results.push(
      compact({
        id: `mfp:${compositeId}`,
        canonicalKey: `mfp:${compositeId}`,
        source: "mfp" as const,
        sourceLabel: "MFP" as const,
        name,
        brand: asString(source.brand_name) ?? asString(item.brand_name),
        serving: formatServing(source.serving_sizes) ?? formatServing(item.serving_sizes),
        nutrition,
        verified: item.verified === true || source.verified === true ? (true as const) : undefined,
      }),
    );
  }
  return results;
};

// Lowercased words without accents; trailing plural "s"/"es" is dropped so
// "beans" matches "bean".
const searchWords = (value: string): Array<string> =>
  value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .map((word) => (word.length > 4 && word.endsWith("es") ? word.slice(0, -2) : word))
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));

// 0 when the name contains every query word, 1 when it contains some, 2 when
// none (the item matched only on its brand). A query word also matches a
// longer name word it starts, since search runs while the user types.
const nameMatchTier = (name: string, queryWords: ReadonlyArray<string>): number => {
  if (queryWords.length === 0) return 0;
  const nameWords = searchWords(name);
  const matched = queryWords.filter((query) =>
    nameWords.some((word) => word.startsWith(query)),
  ).length;
  return matched === queryWords.length ? 0 : matched > 0 ? 1 : 2;
};

// Reorders one page of MFP results: names matching the query before
// brand-only matches, and MFP-verified entries first within each group.
// MFP's own order breaks ties. Only the page is reordered, so pagination
// windows stay aligned.
export const rankMfpResults = (
  foods: ReadonlyArray<FoodSearchResult>,
  query: string,
): Array<FoodSearchResult> => {
  const queryWords = searchWords(query);
  return foods
    .map((food, index) => ({ food, index, tier: nameMatchTier(food.name, queryWords), verified: food.verified ? 0 : 1 }))
    .sort((a, b) => a.tier - b.tier || a.verified - b.verified || a.index - b.index)
    .map(({ food }) => food);
};

// --- Open Food Facts -----------------------------------------------------------

const offValue = (nutriments: Record<string, unknown> | undefined, key: string, preferServing: boolean) =>
  (preferServing ? asNumber(nutriments?.[`${key}_serving`]) : undefined) ??
  asNumber(nutriments?.[`${key}_100g`]) ??
  asNumber(nutriments?.[`${key}_value`]) ??
  asNumber(nutriments?.[key]);

const offMineralMg = (nutriments: Record<string, unknown> | undefined, key: string, preferServing: boolean) => {
  const value = offValue(nutriments, key, preferServing);
  if (value === undefined) {
    return undefined;
  }
  const unit = asString(nutriments?.[`${key}_unit`])?.toLowerCase();
  if (unit === "g") {
    return value * 1000;
  }
  if (unit === "kg") {
    return value * 1_000_000;
  }
  if (unit === "µg" || unit === "ug") {
    return value / 1000;
  }
  return value;
};

const mapOpenFoodFactsNutrition = (nutriments: Record<string, unknown> | undefined, preferServing: boolean) =>
  compactNutrition({
    calories: offValue(nutriments, "energy-kcal", preferServing),
    protein: offValue(nutriments, "proteins", preferServing),
    carbs: offValue(nutriments, "carbohydrates", preferServing),
    fat: offValue(nutriments, "fat", preferServing),
    fiber: offValue(nutriments, "fiber", preferServing),
    sugars: offValue(nutriments, "sugars", preferServing),
    sodiumMg: offMineralMg(nutriments, "sodium", preferServing),
    potassiumMg: offMineralMg(nutriments, "potassium", preferServing),
  });

export const mapOpenFoodFactsSearchResults = (status: number, data: unknown): Array<FoodSearchResult> => {
  if (status < 200 || status >= 300) {
    return [];
  }
  const results: Array<FoodSearchResult> = [];
  const seen = new Set<string>();
  for (const value of asArray(asRecord(data)?.products)) {
    const product = asRecord(value);
    const code = asString(product?.code);
    const name = asString(product?.product_name);
    if (!code || !name || seen.has(code)) {
      continue;
    }
    const nutriments = asRecord(product?.nutriments);
    const rawServing = asString(product?.serving_size) || asString(product?.quantity);
    // Prefer per-serving values when OFF has them; otherwise values are per 100 g.
    const hasServingData = !!asNumber(nutriments?.["energy-kcal_serving"]);
    const nutrition = mapOpenFoodFactsNutrition(nutriments, hasServingData);
    if (!nutrition) {
      continue;
    }
    seen.add(code);
    results.push(
      compact({
        id: `off:${code}`,
        canonicalKey: `off:${code}`,
        source: "openfoodfacts" as const,
        sourceLabel: "OFF" as const,
        name,
        brand: asString(product?.brands),
        serving: hasServingData ? rawServing : rawServing ? `${rawServing} (per 100g)` : "100g",
        nutrition,
      }),
    );
  }
  return results;
};

export const computeOpenFoodFactsHasMore = (data: unknown, page: number, pageSize: number): boolean => {
  const body = asRecord(data);
  const total = asNumber(body?.count);
  if (total !== undefined) {
    return page * pageSize < total;
  }
  return asArray(body?.products).length >= pageSize;
};

// --- ANMAT -----------------------------------------------------------------------

export interface AnmatRow {
  readonly productId: number;
  readonly ingestSource: string;
  readonly detailKey: string | null;
  readonly rnpa: string | null;
  readonly denominacion: string | null;
  readonly nombreFantasia: string | null;
  readonly marca: string | null;
  readonly titular: string | null;
  readonly importedAt: Date | null;
  readonly nutritionFound: boolean | null;
  readonly servingText: string | null;
  readonly servingQuantity: number | null;
  readonly servingUnit: string | null;
  readonly calories: number | null;
  readonly proteinGrams: string | null;
  readonly carbsGrams: string | null;
  readonly fatGrams: string | null;
  readonly fiberGrams: string | null;
  readonly sugarsGrams: string | null;
  readonly sodiumMg: number | null;
}

const normalizeSearchText = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

const parseTextNumber = (value: string | null | undefined) => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const buildAnmatCanonicalKey = (row: {
  readonly detailKey?: string | null;
  readonly rnpa?: string | null;
  readonly nombreFantasia?: string | null;
  readonly denominacion?: string | null;
  readonly marca?: string | null;
}): string => {
  const detailKey = normalizeSearchText(row.detailKey);
  if (detailKey) {
    return `anmat:detail:${detailKey}`;
  }
  const rnpa = normalizeSearchText(row.rnpa);
  if (rnpa) {
    return `anmat:rnpa:${rnpa}`;
  }
  return `anmat:text:${[row.nombreFantasia, row.denominacion, row.marca]
    .map(normalizeSearchText)
    .filter(Boolean)
    .join("|")}`;
};

export const scoreSearchField = (
  value: string | null | undefined,
  queryLower: string,
  queryTokens: ReadonlyArray<string>,
): number => {
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
  return queryTokens.filter((token) => normalized.includes(token)).length * 8;
};

export const mapAnmatRowToFood = (row: AnmatRow): FoodSearchResult | undefined => {
  const name = row.nombreFantasia?.trim() || row.denominacion?.trim() || undefined;
  if (!name) {
    return undefined;
  }
  const nutrition = compactNutrition({
    calories: row.calories ?? undefined,
    protein: parseTextNumber(row.proteinGrams),
    carbs: parseTextNumber(row.carbsGrams),
    fat: parseTextNumber(row.fatGrams),
    fiber: parseTextNumber(row.fiberGrams),
    sugars: parseTextNumber(row.sugarsGrams),
    sodiumMg: row.sodiumMg ?? undefined,
  });
  if (!nutrition) {
    return undefined;
  }
  return compact({
    id: `anmat:${row.productId}`,
    canonicalKey: buildAnmatCanonicalKey(row),
    source: "anmat" as const,
    sourceLabel: "ANMAT" as const,
    name,
    brand: row.marca ?? undefined,
    serving:
      row.servingText?.trim() ||
      (row.servingQuantity !== null && row.servingUnit ? `${row.servingQuantity} ${row.servingUnit}` : undefined),
    nutrition,
  });
};

// Scores rows against the query, keeps the best row per canonical product
// (live-search rows and newer imports win ties) and returns the top `limit`.
export const rankAnmatRows = (
  rows: ReadonlyArray<AnmatRow>,
  query: string,
  limit: number,
): Array<FoodSearchResult> => {
  const queryLower = query.trim().toLowerCase();
  const queryTokens = queryLower.split(/\s+/).filter(Boolean);
  const best = new Map<string, { score: number; liveRank: number; importedAtMs: number; food: FoodSearchResult }>();

  for (const row of rows) {
    const food = mapAnmatRowToFood(row);
    if (!food) {
      continue;
    }
    const isLive = row.ingestSource === "live_search";
    const score =
      scoreSearchField(row.nombreFantasia, queryLower, queryTokens) * 1.2 +
      scoreSearchField(row.denominacion, queryLower, queryTokens) +
      scoreSearchField(row.marca, queryLower, queryTokens) * 0.85 +
      scoreSearchField(row.titular, queryLower, queryTokens) * 0.35 +
      scoreSearchField(row.rnpa, queryLower, queryTokens) * 0.5 +
      (row.nutritionFound ? 12 : 0) +
      (isLive ? 6 : 0);
    if (score <= 0) {
      continue;
    }
    const liveRank = isLive ? 1 : 0;
    const importedAtMs = row.importedAt?.getTime() ?? 0;
    const current = best.get(food.canonicalKey);
    if (
      !current ||
      score > current.score ||
      (score === current.score && liveRank > current.liveRank) ||
      (score === current.score && liveRank === current.liveRank && importedAtMs > current.importedAtMs)
    ) {
      best.set(food.canonicalKey, { score, liveRank, importedAtMs, food });
    }
  }

  return [...best.values()]
    .sort(
      (left, right) =>
        right.score - left.score || right.liveRank - left.liveRank || right.importedAtMs - left.importedAtMs,
    )
    .slice(0, limit)
    .map((entry) => entry.food);
};

// --- Merging -----------------------------------------------------------------------

// Sources are concatenated in priority order rather than interleaved: in a
// blind relevance eval of real assistant queries, putting OFF results between
// MFP ones made the top result a good match 65% of the time vs 82% MFP-first.
export const mergeFoodResults = (
  sources: ReadonlyArray<ReadonlyArray<FoodSearchResult>>,
  limit: number,
): Array<FoodSearchResult> => {
  const merged: Array<FoodSearchResult> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const candidate of source) {
      if (merged.length >= limit) {
        return merged;
      }
      if (!seen.has(candidate.canonicalKey)) {
        seen.add(candidate.canonicalKey);
        merged.push(candidate);
      }
    }
  }
  return merged;
};
