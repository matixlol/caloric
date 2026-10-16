function getRequiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getNumberEnv(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be a valid number`);
  }
  return parsed;
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name];
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a valid boolean`);
}

const reasoningEfforts = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

function getReasoningEffort(name: string, fallback: ReasoningEffort): ReasoningEffort {
  const raw = Bun.env[name];
  if (!raw) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  const parsed = reasoningEfforts.find((level) => level === normalized);
  if (parsed) {
    return parsed;
  }

  throw new Error(`Environment variable ${name} must be one of: ${reasoningEfforts.join(", ")}`);
}

function parseTrustedOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export const config = {
  port: getNumberEnv("PORT", 8787),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  // Better Auth signs sessions/cookies with this secret; it must be stable
  // across restarts and identical on every backend instance.
  betterAuthSecret: getRequiredEnv("BETTER_AUTH_SECRET"),
  // Public URL the mobile/web clients reach the backend at (used for cookie
  // domain + OTP callback URLs). Defaults to the production backend host.
  betterAuthUrl: Bun.env.BETTER_AUTH_URL?.trim() || "https://backend.caloric.mati.lol",
  // Extra origins allowed to authenticate (app deep-link schemes, web origin).
  // The app schemes are always trusted; this is for anything additional.
  authTrustedOrigins: parseTrustedOrigins(Bun.env.AUTH_TRUSTED_ORIGINS),
  // Browser origin(s) allowed to call the API with credentials (web build).
  webOrigins: parseTrustedOrigins(Bun.env.WEB_ORIGINS),
  // Optional Resend transactional-email credentials for delivering login codes.
  // When unset, login codes are written to the server logs instead of emailed.
  resendApiKey: Bun.env.RESEND_API_KEY,
  authEmailFrom: Bun.env.AUTH_EMAIL_FROM?.trim() || "Caloric <login@caloric.mati.lol>",
  searchCacheTtlDays: Math.max(1, getNumberEnv("SEARCH_CACHE_TTL_DAYS", 30)),
  mfpUsername: Bun.env.MFP_USERNAME,
  mfpPassword: Bun.env.MFP_PASSWORD,
  mfpGuestAccessToken: Bun.env.MFP_GUEST_ACCESS_TOKEN,
  mfpProxyUrl: Bun.env.MFP_PROXY_URL,
  mfpBrowserHeadless: getBooleanEnv("MFP_BROWSER_HEADLESS", true),
  twoCaptchaApiKey: Bun.env.TWO_CAPTCHA_API_KEY,
  detailConcurrency: Math.max(1, getNumberEnv("MFP_DETAIL_CONCURRENCY", 10)),
  requestTimeoutMs: Math.max(
    1000,
    getNumberEnv("MFP_REQUEST_TIMEOUT_MS", 20_000),
  ),
  openFoodFactsBaseUrl: Bun.env.OPEN_FOOD_FACTS_BASE_URL ?? "https://world.openfoodfacts.net",
  openFoodFactsUserAgent:
    Bun.env.OPEN_FOOD_FACTS_USER_AGENT ?? "Caloric/1.0 (OpenFoodFacts integration; contact required)",
  openFoodFactsUserEmail: Bun.env.OPEN_FOOD_FACTS_USER_EMAIL,
  // AI is optional at process startup (for example, the local web preview).
  // OpenRouter reports its configuration error if an AI route is actually used
  // without a key; all non-AI routes remain available.
  openRouterApiKey: Bun.env.OPENROUTER_API_KEY?.trim() || undefined,
  // OpenRouter model ID, optionally pinned to one upstream: "<model>@<provider>".
  aiModel: Bun.env.AI_MODEL?.trim() || "meta/muse-wonder",
  aiReasoningEffort: getReasoningEffort("AI_REASONING_EFFORT", "minimal"),
};
