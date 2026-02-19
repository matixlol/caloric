import { config } from "./config";

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
    Authorization: config.mfpAuthorization,
  };

  if (config.mfpCookie) {
    headers.Cookie = config.mfpCookie;
  }

  return headers;
}

async function request(pathWithQuery: string): Promise<MfpResponse> {
  const url = new URL(pathWithQuery, config.mfpBaseUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: getMfpHeaders(),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });

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
