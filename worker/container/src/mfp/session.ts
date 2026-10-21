// Pure helpers that turn a finished browser session into the auth headers the
// Worker stores. Ported from backend/src/providers/myfitnesspal/debug-session.mjs
// (capture) and session.ts (final normalization).

export const MFP_BASE_URL = "https://www.myfitnesspal.com";

export type ProxyConfig = { server: string; username?: string; password?: string };

export type StorageCookie = { name?: unknown; value?: unknown; domain?: unknown; expires?: unknown };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// debug-session.mjs: recognizes a bearer token while walking captured state.
export function captureAuthorization(value: string | null | undefined, allowOpaqueToken = false): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (/^Bearer\s+/i.test(normalized)) {
    return `Bearer ${normalized.replace(/^Bearer\s+/i, "").trim()}`;
  }

  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
    return `Bearer ${normalized}`;
  }

  if (allowOpaqueToken && /^[A-Za-z0-9._~-]{24,}$/.test(normalized)) {
    return `Bearer ${normalized}`;
  }

  return null;
}

function isAuthorizationLikeKey(key: string): boolean {
  return /authorization|access[_-]?token|token|auth/i.test(key);
}

export function findAuthorizationValue(
  value: unknown,
  depth = 0,
  seen: Set<object> = new Set(),
  parentKey?: string,
): string | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const direct = captureAuthorization(value, Boolean(parentKey && isAuthorizationLikeKey(parentKey)));
    if (direct) {
      return direct;
    }

    const parsed = tryParseJson(value);
    if (parsed !== null) {
      return findAuthorizationValue(parsed, depth + 1, seen, parentKey);
    }

    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findAuthorizationValue(item, depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  const priorityKeys = ["authorization", "auth", "accessToken", "access_token", "token"];
  for (const key of priorityKeys) {
    const nested = findAuthorizationValue(record[key], depth + 1, seen, key);
    if (nested) {
      return nested;
    }
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    const nested = findAuthorizationValue(nestedValue, depth + 1, seen, key);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function cookieMatchesHostname(cookieDomain: string, hostname: string): boolean {
  const normalizedDomain = cookieDomain.replace(/^\./, "").toLowerCase();
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

export function buildCookieHeader(storageState: unknown, nowSeconds = Date.now() / 1000): string | null {
  if (!isRecord(storageState) || !Array.isArray(storageState.cookies)) {
    return null;
  }

  const hostname = new URL(MFP_BASE_URL).hostname;
  const cookies = (storageState.cookies as StorageCookie[]).filter((cookie) => {
    if (!cookie?.name || !cookie?.value || typeof cookie.domain !== "string" || !cookie.domain) {
      return false;
    }

    if (!cookieMatchesHostname(cookie.domain, hostname)) {
      return false;
    }

    return cookie.expires === -1 || (typeof cookie.expires === "number" && cookie.expires > nowSeconds);
  });

  if (cookies.length === 0) {
    return null;
  }

  return cookies.map((cookie) => `${String(cookie.name)}=${String(cookie.value)}`).join("; ");
}

export function getProxyConfig(proxyUrl: string | null | undefined): ProxyConfig | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = new URL(trimmed);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

export function normalize2CaptchaProxy(
  proxyUrl: string | null | undefined,
): { proxy: string; proxyType: string } | null {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new URL(trimmed);
  const protocol = parsed.protocol.replace(":", "").toUpperCase();
  const proxyType = protocol === "HTTPS" ? "HTTP" : protocol;
  const credentials =
    parsed.username || parsed.password
      ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@`
      : "";

  return {
    proxy: `${credentials}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    proxyType,
  };
}

// session.ts: the stricter normalization applied before the session is stored.
function isLikelyHostname(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);
}

function normalizeAuthorizationToken(value: string, allowOpaqueToken: boolean): string | null {
  const normalized = value.trim();
  if (!normalized || isLikelyHostname(normalized)) {
    return null;
  }

  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
    return normalized;
  }

  if (allowOpaqueToken && /^[A-Za-z0-9._~-]{24,}$/.test(normalized)) {
    return normalized;
  }

  return null;
}

export function normalizeAuthorization(value: string | null | undefined, allowOpaqueToken = false): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (/^Bearer\s+/i.test(normalized)) {
    const token = normalizeAuthorizationToken(normalized.replace(/^Bearer\s+/i, ""), allowOpaqueToken);
    return token ? `Bearer ${token}` : null;
  }

  const token = normalizeAuthorizationToken(normalized, allowOpaqueToken);
  return token ? `Bearer ${token}` : null;
}

export function normalizeStorageState(value: unknown): { cookies: unknown[]; origins: unknown[] } | null {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    return null;
  }
  return value as { cookies: unknown[]; origins: unknown[] };
}

export function normalizeSessionStorage(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

export type MfpLoginResult = {
  cookieHeader: string;
  authorization: string | null;
  storageState: { cookies: unknown[]; origins: unknown[] };
  sessionStorage: Record<string, string> | null;
};

export class MfpLoginFailure extends Error {
  override name = "MfpLoginFailure";
}

// Mirrors the checks refreshWithPlaywright() in session.ts runs on state.json.
export function toLoginResult(captured: {
  authorization: string | null;
  storageState: unknown;
  sessionStorage: unknown;
}): MfpLoginResult {
  const storageState = normalizeStorageState(captured.storageState);
  if (!storageState) {
    throw new MfpLoginFailure("MyFitnessPal login finished without storage state.");
  }

  const cookieHeader = buildCookieHeader(storageState)?.trim() ?? "";
  if (!cookieHeader) {
    throw new MfpLoginFailure("MyFitnessPal login finished without a cookie header.");
  }

  return {
    cookieHeader,
    authorization: normalizeAuthorization(captured.authorization, true),
    storageState,
    sessionStorage: normalizeSessionStorage(captured.sessionStorage),
  };
}
