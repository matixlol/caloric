const SEARCH_MAX_ITEMS_DEFAULT = 20;
const LIVE_ANMAT_MAX_ITEMS_DEFAULT = 8;
const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

export type SearchFoodSource = "mfp" | "anmat";

export type SearchFood = {
  id: string;
  canonicalKey: string;
  source: SearchFoodSource;
  sourceLabel: "MFP" | "ANMAT";
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
  foods?: SearchFood[] | null;
  error?: unknown;
  message?: unknown;
};

type LiveSearchPayload = {
  query?: unknown;
  foods?: SearchFood[] | null;
  eanAttempted?: unknown;
  eanStatus?: unknown;
  error?: unknown;
  message?: unknown;
};

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

function mapSearchFood(value: unknown): SearchFood | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const food = value as Record<string, unknown>;
  const id = asString(food.id);
  const canonicalKey = asString(food.canonicalKey);
  const source = food.source === "anmat" ? "anmat" : food.source === "mfp" ? "mfp" : null;
  const sourceLabel = food.sourceLabel === "ANMAT" ? "ANMAT" : food.sourceLabel === "MFP" ? "MFP" : null;
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

  return {
    id,
    canonicalKey,
    source,
    sourceLabel,
    name,
    brand: asString(food.brand),
    serving: asString(food.serving),
    nutrition:
      nutrition && Object.values(nutrition).some((entry) => entry !== undefined) ? nutrition : undefined,
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

function getPayloadErrorMessage(payload: SearchResponsePayload | LiveSearchPayload | null): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (typeof payload.message === "string" && payload.message.trim().length > 0) {
    return payload.message;
  }

  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return payload.error;
  }

  return undefined;
}

function mergeFoods(currentFoods: SearchFood[], nextFoods: SearchFood[], maxItems: number): SearchFood[] {
  const merged: SearchFood[] = [];
  const seen = new Set<string>();

  for (const food of [...nextFoods, ...currentFoods]) {
    if (seen.has(food.canonicalKey)) {
      continue;
    }
    seen.add(food.canonicalKey);
    merged.push(food);
    if (merged.length >= maxItems) {
      break;
    }
  }

  return merged;
}

async function fetchBaseSearch(
  query: string,
  signal: AbortSignal | undefined,
  maxItems: number,
): Promise<SearchFood[]> {
  const url = new URL("/search", `${BACKEND_BASE_URL}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("maxItems", String(maxItems));

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
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

  return mapFoods(payload);
}

async function refreshAnmatLive(
  query: string,
  signal: AbortSignal | undefined,
  maxItems: number,
): Promise<SearchFood[]> {
  const response = await fetch(new URL("/search/anmat-live", `${BACKEND_BASE_URL}/`).toString(), {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      maxItems,
    }),
  });

  let payload: LiveSearchPayload | null = null;
  try {
    payload = (await response.json()) as LiveSearchPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getPayloadErrorMessage(payload) ?? `Live ANMAT search failed with ${response.status}`);
  }

  return mapFoods(payload);
}

export async function searchFoods(
  query: string,
  options: {
    signal?: AbortSignal;
    maxItems?: number;
    liveAnmatMaxItems?: number;
    onBackgroundResults?: (foods: SearchFood[]) => void;
  } = {},
): Promise<SearchFood[]> {
  const maxItems = options.maxItems ?? SEARCH_MAX_ITEMS_DEFAULT;
  const liveAnmatMaxItems = options.liveAnmatMaxItems ?? LIVE_ANMAT_MAX_ITEMS_DEFAULT;
  const baseFoods = await fetchBaseSearch(query, options.signal, maxItems);

  if (options.onBackgroundResults) {
    void refreshAnmatLive(query, options.signal, liveAnmatMaxItems)
      .then((liveFoods) => {
        if (options.signal?.aborted) {
          return;
        }
        options.onBackgroundResults?.(mergeFoods(baseFoods, liveFoods, maxItems));
      })
      .catch(() => {
        // Background refresh is opportunistic; keep the initial results if it fails.
      });
  }

  return baseFoods;
}
