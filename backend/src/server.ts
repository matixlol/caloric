import { db } from "./db";
import { mfpFoodDetailResponses, mfpSearchResponses } from "./db/schema";
import { config } from "./config";
import { fetchFoodDetail, searchNutrition } from "./mfp-client";
import { and, desc, eq } from "drizzle-orm";

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

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.port,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname !== "/search") {
      return json({ error: "Not found" }, 404);
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const query = (url.searchParams.get("query") ?? "").trim();
    if (!query) {
      return json({ error: "query is required" }, 400);
    }

    const offset = Math.max(0, parseInteger(url.searchParams.get("offset"), 0));
    const maxItems = Math.max(1, Math.min(1000, parseInteger(url.searchParams.get("maxItems"), 100)));
    const countryCode = (url.searchParams.get("countryCode") ?? "US").toUpperCase();
    const resourceType = (url.searchParams.get("resourceType") ?? "foods").toLowerCase();
    const includeDetails = parseBoolean(url.searchParams.get("includeDetails"), true);

    try {
      const searchParams = {
        query,
        offset,
        maxItems,
        countryCode,
        resourceType,
      };

      const cachedSearch = await findCachedSearch(searchParams);

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
      } else {
        const searchResponse = await searchNutrition(searchParams);
        const [savedSearch] = await db
          .insert(mfpSearchResponses)
          .values({
            query,
            offset,
            maxItems,
            countryCode,
            resourceType,
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
      }

      if (!includeDetails || !searchPayload.data) {
        return json({
          searchResponseId,
          search: searchPayload,
          detailCount: 0,
          details: [],
        });
      }

      const detailKeys = extractDetailKeys(searchPayload.data);

      const detailTasks = detailKeys.map((key) => async () => {
        const cachedDetail = await findCachedDetail(key.foodId, key.version);
        if (cachedDetail) {
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

          return toDetailPayload(key, {
            mfpStatus: detailResponse.status,
            mfpUrl: detailResponse.url,
            responseJson: detailResponse.json,
            responseText: detailResponse.text,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const fallbackUrl = `${config.mfpBaseUrl}/api/services/foods/${key.foodId}?version=${key.version}`;

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

      return json({
        searchResponseId,
        search: searchPayload,
        detailCount: details.length,
        details,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: "search_failed", message }, 502);
    }
  },
});

console.log(`backend listening on http://${server.hostname}:${server.port}`);
