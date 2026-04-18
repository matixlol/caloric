import { config } from "../../config";
import { logError, logInfo, redactSecret, summarizeText } from "../../logging";
import { getMfpAuthHeaders, MFP_BASE_URL } from "./session";

const MFP_API_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.165 Safari/537.36";

type MfpResponse = {
  status: number;
  url: string;
  json: unknown | null;
  text: string | null;
};

function isAuthorizationErrorResponse(response: MfpResponse): boolean {
  if (response.status !== 400 || !response.json || typeof response.json !== "object") {
    return false;
  }

  const payload = response.json as { error?: unknown; error_description?: unknown };
  return payload.error === "validation/3" &&
    typeof payload.error_description === "string" &&
    payload.error_description.includes("Missing HTTP header: Authorization");
}

async function getMfpHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const auth = await getMfpAuthHeaders({ forceRefresh });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": MFP_API_USER_AGENT,
    Referer: `${MFP_BASE_URL}/food/search`,
    Cookie: auth.cookieHeader,
  };

  if (auth.authorization) {
    headers.Authorization = auth.authorization;
  }

  return headers;
}

async function request(pathWithQuery: string): Promise<MfpResponse> {
  const url = new URL(pathWithQuery, MFP_BASE_URL);
  const startedAt = Date.now();

  const fetchMfp = async (forceRefresh = false): Promise<MfpResponse> => {
    const headers = await getMfpHeaders(forceRefresh);

    logInfo("mfp.request.start", {
      url: url.toString(),
      timeoutMs: config.requestTimeoutMs,
      forceRefresh,
      hasAuthorization: Boolean(headers.Authorization),
      authorizationPreview: redactSecret(headers.Authorization),
      hasCookie: Boolean(headers.Cookie),
      cookiePreview: redactSecret(headers.Cookie),
      headers: Object.keys(headers).sort(),
    });

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

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
  };

  try {
    const response = await fetchMfp();
    if (response.status === 401 || response.status === 403 || isAuthorizationErrorResponse(response)) {
      return fetchMfp(true);
    }

    return response;
  } catch (error) {
    logError("mfp.request.fetch_failed", error, {
      url: url.toString(),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
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
