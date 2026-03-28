import { config } from "./config";
import { getMfpAuthHeaders, MFP_BASE_URL, MFP_USER_AGENT } from "./mfp-session";

type MfpResponse = {
  status: number;
  url: string;
  json: unknown | null;
  text: string | null;
};

async function getMfpHeaders(forceRefresh = false): Promise<HeadersInit> {
  const auth = await getMfpAuthHeaders({ forceRefresh });

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": MFP_USER_AGENT,
    Referer: `${MFP_BASE_URL}/food/search`,
    Authorization: auth.authorization,
    Cookie: auth.cookieHeader,
  };

  return headers;
}

async function fetchMfp(url: URL, forceRefresh = false): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: await getMfpHeaders(forceRefresh),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
}

async function request(pathWithQuery: string): Promise<MfpResponse> {
  const url = new URL(pathWithQuery, MFP_BASE_URL);
  let response = await fetchMfp(url);

  if (response.status === 401 || response.status === 403) {
    response = await fetchMfp(url, true);
  }

  const text = await response.text();
  let json: unknown | null = null;

  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

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
