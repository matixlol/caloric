import { db } from "./db";
import { mfpFoodDetailResponses, mfpSearchResponses } from "./db/schema";
import { config } from "./config";
import { fetchFoodDetail, searchNutrition } from "./mfp-client";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

type SearchItem = {
  item?: {
    id?: string | number;
    version?: string | number;
  };
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
      const searchResponse = await searchNutrition({
        query,
        offset,
        maxItems,
        countryCode,
        resourceType,
      });

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

      if (!includeDetails || !searchResponse.json) {
        return json({
          searchResponseId: savedSearch.id,
          search: {
            status: searchResponse.status,
            url: searchResponse.url,
            data: searchResponse.json,
            text: searchResponse.text,
          },
          detailCount: 0,
          details: [],
        });
      }

      const detailKeys = extractDetailKeys(searchResponse.json);

      const detailTasks = detailKeys.map((key) => async () => {
        try {
          const detailResponse = await fetchFoodDetail(key.foodId, key.version);

          await db
            .insert(mfpFoodDetailResponses)
            .values({
              searchResponseId: savedSearch.id,
              foodId: key.foodId,
              version: key.version,
              mfpUrl: detailResponse.url,
              mfpStatus: detailResponse.status,
              responseJson: detailResponse.json,
              responseText: detailResponse.text,
            })
            .onConflictDoNothing();

          return {
            foodId: key.foodId,
            version: key.version,
            status: detailResponse.status,
            data: detailResponse.json,
            text: detailResponse.text,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          await db
            .insert(mfpFoodDetailResponses)
            .values({
              searchResponseId: savedSearch.id,
              foodId: key.foodId,
              version: key.version,
              mfpUrl: `${config.mfpBaseUrl}/api/services/foods/${key.foodId}?version=${key.version}`,
              mfpStatus: 0,
              responseJson: null,
              responseText: message,
            })
            .onConflictDoNothing();

          return {
            foodId: key.foodId,
            version: key.version,
            status: 0,
            data: null,
            text: message,
          };
        }
      });

      const details = await runWithConcurrency(detailTasks, config.detailConcurrency);

      return json({
        searchResponseId: savedSearch.id,
        search: {
          status: searchResponse.status,
          url: searchResponse.url,
          data: searchResponse.json,
          text: searchResponse.text,
        },
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
