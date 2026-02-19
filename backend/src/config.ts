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
  mfpAuthorization: getRequiredEnv("MFP_AUTHORIZATION"),
  mfpBaseUrl: Bun.env.MFP_BASE_URL ?? "https://www.myfitnesspal.com",
  mfpCookie: Bun.env.MFP_COOKIE,
  detailConcurrency: Math.max(1, getNumberEnv("MFP_DETAIL_CONCURRENCY", 10)),
  requestTimeoutMs: Math.max(1000, getNumberEnv("MFP_REQUEST_TIMEOUT_MS", 20_000)),
};
