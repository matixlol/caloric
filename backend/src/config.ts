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

export const config = {
  port: getNumberEnv("PORT", 8787),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  browserlessApiToken: Bun.env.BROWSERLESS_API_TOKEN,
  mfpUsername: Bun.env.MFP_USERNAME,
  mfpPassword: Bun.env.MFP_PASSWORD,
  mfpProxyUrl: Bun.env.MFP_PROXY_URL,
  mfpBrowserHeadless: getBooleanEnv("MFP_BROWSER_HEADLESS", true),
  twoCaptchaApiKey: Bun.env.TWO_CAPTCHA_API_KEY,
  groqApiKey: Bun.env.GROQ_API_KEY,
  detailConcurrency: Math.max(1, getNumberEnv("MFP_DETAIL_CONCURRENCY", 10)),
  requestTimeoutMs: Math.max(1000, getNumberEnv("MFP_REQUEST_TIMEOUT_MS", 20_000)),
  openRouterApiKey: getRequiredEnv("OPENROUTER_API_KEY"),
  openRouterModel: Bun.env.OPENROUTER_MODEL ?? "moonshotai/kimi-k2-0905",
  openRouterProviderOnly: Bun.env.OPENROUTER_PROVIDER_ONLY ?? "groq",
};
