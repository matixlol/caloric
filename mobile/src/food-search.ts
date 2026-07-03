// One page worth of results requested from each source.
export const SEARCH_PAGE_SIZE = 20;
// How many pages of infinite scroll we allow per source.
export const SEARCH_MAX_PAGES = 10;

const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

export type SearchFoodSource = "mfp" | "anmat" | "openfoodfacts";

// Sources whose results are shown to the user. ANMAT is intentionally excluded:
// we still record ANMAT search queries (see queueAnmatQuery) so they can seed
// ANMAT results later, but we don't display ANMAT foods yet.
export type DisplayedFoodSource = "openfoodfacts" | "mfp";

export const DISPLAYED_SOURCE_ORDER: DisplayedFoodSource[] = ["openfoodfacts", "mfp"];

export type SearchFood = {
  id: string;
  canonicalKey: string;
  source: SearchFoodSource;
  sourceLabel: "MFP" | "ANMAT" | "OFF";
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: {
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number;
    sugars?: number;
    sodiumMg?: number;
    potassiumMg?: number;
  };
};

type SearchResponsePayload = {
  query?: unknown;
  provider?: unknown;
  page?: unknown;
  hasMore?: unknown;
  foods?: SearchFood[] | null;
  error?: unknown;
  message?: unknown;
};

export type SearchFoodsBySource = Record<DisplayedFoodSource, SearchFood[]>;

export type FoodSourcePage = {
  foods: SearchFood[];
  hasMore: boolean;
};

export function createEmptyFoodsBySource(): SearchFoodsBySource {
  return {
    openfoodfacts: [],
    mfp: [],
  };
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

function hasNutrition(
  nutrition: SearchFood["nutrition"],
): nutrition is NonNullable<SearchFood["nutrition"]> {
  return !!nutrition && Object.values(nutrition).some((value) => value !== undefined);
}

function mapSearchFood(value: unknown): SearchFood | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const food = value as Record<string, unknown>;
  const id = asString(food.id);
  const canonicalKey = asString(food.canonicalKey);
  const source =
    food.source === "anmat"
      ? "anmat"
      : food.source === "mfp"
        ? "mfp"
        : food.source === "openfoodfacts"
          ? "openfoodfacts"
          : null;
  const sourceLabel =
    food.sourceLabel === "ANMAT"
      ? "ANMAT"
      : food.sourceLabel === "MFP"
        ? "MFP"
        : food.sourceLabel === "OFF"
          ? "OFF"
          : null;
  const name = asString(food.name);

  if (!id || !canonicalKey || !source || !sourceLabel || !name) {
    return null;
  }

  const nutritionSource =
    food.nutrition && typeof food.nutrition === "object" ? (food.nutrition as Record<string, unknown>) : null;

  const nutrition = nutritionSource
    ? {
        calories: asNumber(nutritionSource.calories),
        protein: asNumber(nutritionSource.protein),
        carbs: asNumber(nutritionSource.carbs),
        fat: asNumber(nutritionSource.fat),
        fiber: asNumber(nutritionSource.fiber),
        sugars: asNumber(nutritionSource.sugars),
        sodiumMg: asNumber(nutritionSource.sodiumMg),
        potassiumMg: asNumber(nutritionSource.potassiumMg),
      }
    : undefined;
  if (!hasNutrition(nutrition)) {
    return null;
  }

  return {
    id,
    canonicalKey,
    source,
    sourceLabel,
    name,
    brand: asString(food.brand),
    serving: asString(food.serving),
    nutrition,
  };
}

function mapFoods(payload: { foods?: SearchFood[] | null } | null | undefined): SearchFood[] {
  const rows = payload?.foods;
  if (!Array.isArray(rows)) {
    return [];
  }

  const foods: SearchFood[] = [];
  for (const row of rows) {
    const mapped = mapSearchFood(row);
    if (mapped) {
      foods.push(mapped);
    }
  }

  return foods;
}

function getPayloadErrorMessage(payload: SearchResponsePayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message === "Unknown error." ? payload.message : "Unknown error.";
  }

  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error === "Unknown error." ? payload.error : "Unknown error.";
  }

  return undefined;
}

// Fetches a single page of results for one displayed source. `page` is
// 1-indexed; `hasMore` reflects whether the source likely has another page.
export async function fetchFoodSourcePage(
  query: string,
  source: DisplayedFoodSource,
  page: number,
  options: {
    signal?: AbortSignal;
    pageSize?: number;
  } = {},
): Promise<FoodSourcePage> {
  const pageSize = options.pageSize ?? SEARCH_PAGE_SIZE;
  const url = new URL("/search", `${BACKEND_BASE_URL}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("maxItems", String(pageSize));
  url.searchParams.set("page", String(page));
  url.searchParams.set("provider", source);

  const response = await fetch(url.toString(), {
    method: "GET",
    signal: options.signal,
  });

  let payload: SearchResponsePayload | null = null;
  try {
    payload = (await response.json()) as SearchResponsePayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getPayloadErrorMessage(payload) ?? `Search request failed with ${response.status}`);
  }

  return {
    foods: mapFoods(payload),
    hasMore: payload?.hasMore === true,
  };
}

// Records the search query so ANMAT results can be seeded from it later. We
// intentionally do not surface the (empty) response — this only enqueues the
// query on the backend.
export async function queueAnmatQuery(
  query: string,
  options: {
    signal?: AbortSignal;
    pageSize?: number;
  } = {},
): Promise<void> {
  const maxItems = options.pageSize ?? SEARCH_PAGE_SIZE;
  const response = await fetch(new URL("/search/anmat-live", `${BACKEND_BASE_URL}/`).toString(), {
    method: "POST",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      maxItems,
    }),
  });

  let payload: SearchResponsePayload | null = null;
  try {
    payload = (await response.json()) as SearchResponsePayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getPayloadErrorMessage(payload) ?? `Search request failed with ${response.status}`);
  }
}

// Round-robins one page's per-source results into a single block, deduping on
// canonicalKey. Pass a shared `seen` set to also drop items already merged from
// earlier pages — this keeps the combined "All" list append-only and stable
// (a new page only ever adds items to the end, never reorders earlier ones).
export function interleaveFoods(sources: SearchFood[][], seen: Set<string> = new Set()): SearchFood[] {
  const merged: SearchFood[] = [];
  const cursors = sources.map(() => 0);

  let advanced = true;
  while (advanced) {
    advanced = false;

    for (let index = 0; index < sources.length; index += 1) {
      const foods = sources[index];

      while (cursors[index] < foods.length) {
        const candidate = foods[cursors[index]];
        cursors[index] += 1;

        if (seen.has(candidate.canonicalKey)) {
          continue;
        }

        seen.add(candidate.canonicalKey);
        merged.push(candidate);
        advanced = true;
        break;
      }
    }
  }

  return merged;
}

// Appends new rows to an accumulated source list, dropping duplicates by
// canonicalKey (deeper pages can overlap the first page's over-fetch).
export function appendUniqueFoods(existing: SearchFood[], incoming: SearchFood[]): SearchFood[] {
  const seen = new Set(existing.map((food) => food.canonicalKey));
  const merged = [...existing];

  for (const food of incoming) {
    if (seen.has(food.canonicalKey)) {
      continue;
    }
    seen.add(food.canonicalKey);
    merged.push(food);
  }

  return merged;
}

export async function lookupFoodBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<SearchFood[]> {
  const url = new URL(`/search/barcode/${encodeURIComponent(barcode)}`, `${BACKEND_BASE_URL}/`);
  const response = await fetch(url.toString(), { method: "GET", signal });

  let payload: SearchResponsePayload | null = null;
  try {
    payload = (await response.json()) as SearchResponsePayload;
  } catch {
    payload = null;
  }

  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(getPayloadErrorMessage(payload) ?? `Barcode lookup failed with ${response.status}`);
  }
  return mapFoods(payload);
}
