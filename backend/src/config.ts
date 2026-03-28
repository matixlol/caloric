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

export const config = {
  port: getNumberEnv("PORT", 8787),
  databaseUrl: getRequiredEnv("DATABASE_URL"),
  mfpUsername: Bun.env.MFP_USERNAME,
  mfpPassword: Bun.env.MFP_PASSWORD,
  browserbaseApiKey: Bun.env.BROWSERBASE_API_KEY,
  browserbaseProjectId: Bun.env.BROWSERBASE_PROJECT_ID,
  groqApiKey: Bun.env.GROQ_API_KEY,
  detailConcurrency: Math.max(1, getNumberEnv("MFP_DETAIL_CONCURRENCY", 10)),
  requestTimeoutMs: Math.max(1000, getNumberEnv("MFP_REQUEST_TIMEOUT_MS", 20_000)),
  openRouterApiKey: getRequiredEnv("OPENROUTER_API_KEY"),
  openRouterModel: Bun.env.OPENROUTER_MODEL ?? "moonshotai/kimi-k2-0905",
  openRouterProviderOnly: Bun.env.OPENROUTER_PROVIDER_ONLY ?? "groq",
};
