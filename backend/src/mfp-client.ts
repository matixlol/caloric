import { config } from "./config";
import { logError, logInfo, redactSecret, summarizeText } from "./logging";

type MfpResponse = {
  status: number;
  url: string;
  json: unknown | null;
  text: string | null;
};

function getMfpHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    Referer: `${config.mfpBaseUrl}/food/search`,
  };

  if (config.mfpAuthorization) {
    headers.Authorization = config.mfpAuthorization;
  }

  if (config.mfpCookie) {
    headers.Cookie = config.mfpCookie;
  }

  return headers;
}

async function request(pathWithQuery: string): Promise<MfpResponse> {
  const url = new URL(pathWithQuery, config.mfpBaseUrl);
  const headers = getMfpHeaders();
  const startedAt = Date.now();

  logInfo("mfp.request.start", {
    url: url.toString(),
    timeoutMs: config.requestTimeoutMs,
    hasAuthorization: Boolean(config.mfpAuthorization),
    authorizationPreview: redactSecret(config.mfpAuthorization),
    hasCookie: Boolean(config.mfpCookie),
    cookiePreview: redactSecret(config.mfpCookie),
    headers: Object.keys(headers).sort(),
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    logError("mfp.request.fetch_failed", error, {
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

  logInfo("mfp.request.complete", {
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

export type SearchParams = {
  query: string;
  offset: number;
  maxItems: number;
  countryCode: string;
  resourceType: string;
};

export async function searchNutrition(params: SearchParams): Promise<MfpResponse> {
  const query = new URLSearchParams({
    query: params.query,
    offset: String(params.offset),
    max_items: String(params.maxItems),
    country_code: params.countryCode,
    resource_type: params.resourceType,
  });

  return request(`/api/nutrition?${query.toString()}`);
}

export async function fetchFoodDetail(foodId: string, version: string): Promise<MfpResponse> {
  const query = new URLSearchParams({ version });
  return request(`/api/services/foods/${encodeURIComponent(foodId)}?${query.toString()}`);
}
