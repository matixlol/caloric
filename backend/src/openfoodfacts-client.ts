import { config } from "./config";
import { logError, logInfo, summarizeText } from "./logging";

export const OPEN_FOOD_FACTS_BASE_URL = config.openFoodFactsBaseUrl.replace(/\/+$/, "");

export type OpenFoodFactsResponse = {
  status: number;
  url: string;
  json: unknown | null;
  text: string | null;
};

export type OpenFoodFactsSearchParams = {
  query: string;
  page: number;
  pageSize: number;
};

const OPEN_FOOD_FACTS_FIELDS = [
  "code",
  "product_name",
  "brands",
  "quantity",
  "serving_size",
  "nutriments",
].join(",");

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": config.openFoodFactsUserAgent,
  };

  if (config.openFoodFactsUserEmail?.trim()) {
    headers["From"] = config.openFoodFactsUserEmail.trim();
  }

  return headers;
}

export async function searchOpenFoodFacts(params: OpenFoodFactsSearchParams): Promise<OpenFoodFactsResponse> {
  const url = new URL("/cgi/search.pl", `${OPEN_FOOD_FACTS_BASE_URL}/`);
  url.searchParams.set("search_terms", params.query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page", String(params.page));
  url.searchParams.set("page_size", String(params.pageSize));
  url.searchParams.set("fields", OPEN_FOOD_FACTS_FIELDS);

  const startedAt = Date.now();

  logInfo("open_food_facts.request.start", {
    url: url.toString(),
    page: params.page,
    pageSize: params.pageSize,
    timeoutMs: config.requestTimeoutMs,
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: buildHeaders(),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    logError("open_food_facts.request.fetch_failed", error, {
      url: url.toString(),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }

  const text = await response.text();
  let json: unknown | null = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  logInfo("open_food_facts.request.complete", {
    url: url.toString(),
    responseUrl: response.url,
    status: response.status,
    ok: response.ok,
    durationMs: Date.now() - startedAt,
    contentType: response.headers.get("content-type"),
    jsonParsed: json !== null,
    textPreview: json ? null : summarizeText(text),
  });

  return {
    status: response.status,
    url: response.url,
    json,
    text: json ? null : text,
  };
}
