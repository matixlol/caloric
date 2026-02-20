const SEARCH_MAX_ITEMS_DEFAULT = 20;
const BACKEND_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL?.trim() ?? "").replace(/\/+$/, "") ||
  "https://backend.caloric.mati.lol";

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

type SearchPayload = {
  search?: {
    data?: {
      items?: { item?: MfpFood | null }[];
    } | null;
  } | null;
  details?: {
    foodId?: unknown;
    version?: unknown;
    status?: unknown;
    data?: MfpFood | null;
  }[] | null;
  error?: unknown;
  message?: unknown;
};

export type SearchFood = {
  id: string;
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

function mapNutrition(contents: MfpNutritionalContents | null | undefined): SearchFood["nutrition"] {
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

function mapSearchResults(payload: SearchPayload): SearchFood[] {
  const detailById = new Map<string, MfpFood>();
  const details = payload.details ?? [];

  for (const detail of details) {
    if (!detail || typeof detail !== "object") {
      continue;
    }

    const status = asNumber(detail.status);
    if (status !== 200 || !detail.data || typeof detail.data !== "object") {
      continue;
    }

    const foodId = asString(detail.foodId);
    const version = asString(detail.version);
    if (!foodId || !version) {
      continue;
    }

    detailById.set(`${foodId}:${version}`, detail.data);
  }

  const items = payload.search?.data?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  const results: SearchFood[] = [];
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

    results.push({
      id: compositeId,
      name,
      brand,
      serving,
      nutrition,
    });
  }

  return results;
}

function getPayloadErrorMessage(payload: SearchPayload | null): string | undefined {
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

export async function searchFoods(
  query: string,
  options: {
    signal?: AbortSignal;
    maxItems?: number;
  } = {},
): Promise<SearchFood[]> {
  const url = new URL("/search", `${BACKEND_BASE_URL}/`);
  url.searchParams.set("query", query);
  url.searchParams.set("maxItems", String(options.maxItems ?? SEARCH_MAX_ITEMS_DEFAULT));
  url.searchParams.set("includeDetails", "true");

  const response = await fetch(url.toString(), {
    method: "GET",
    signal: options.signal,
  });

  let payload: SearchPayload | null = null;
  try {
    payload = (await response.json()) as SearchPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(getPayloadErrorMessage(payload) ?? `Search request failed with ${response.status}`);
  }

  return mapSearchResults(payload ?? {});
}
