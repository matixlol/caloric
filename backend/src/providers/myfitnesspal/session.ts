import { eq } from "drizzle-orm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../config";
import { db } from "../../db";
import { mfpAuthSessions } from "../../db/schema";

export const MFP_BASE_URL = "https://www.myfitnesspal.com";

const MFP_PROVIDER = "myfitnesspal";
const BACKEND_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

type SessionStorageState = Record<string, string>;

type MfpStorageCookie = {
  name: string;
  value: string;
  domain: string;
  expires: number;
};

type MfpStorageState = {
  cookies: MfpStorageCookie[];
  origins: unknown[];
};

type StoredMfpAuthSession = {
  storageState: MfpStorageState | null;
  sessionStorage: SessionStorageState | null;
  authorization: string | null;
  cookieHeader: string | null;
};

type MfpDebugState = {
  auth?: {
    authorization?: unknown;
    cookieHeader?: unknown;
    sessionPayload?: unknown;
    sessionStorage?: unknown;
    storageState?: unknown;
  } | null;
};

export type MfpRequestAuth = {
  authorization: string | null;
  cookieHeader: string;
};

let refreshPromise: Promise<MfpRequestAuth> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStorageState(value: unknown): MfpStorageState | null {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    return null;
  }

  return value as MfpStorageState;
}

function normalizeSessionStorage(value: unknown): SessionStorageState | null {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function isLikelyHostname(value: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(value);
}

function normalizeAuthorizationToken(value: string, allowOpaqueToken = false): string | null {
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

function normalizeAuthorization(value: string | null | undefined, allowOpaqueToken = false): string | null {
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

async function readStoredSession(): Promise<StoredMfpAuthSession | null> {
  const [storedSession] = await db
    .select({
      storageState: mfpAuthSessions.storageState,
      sessionStorage: mfpAuthSessions.sessionStorage,
      authorization: mfpAuthSessions.authorization,
      cookieHeader: mfpAuthSessions.cookieHeader,
    })
    .from(mfpAuthSessions)
    .where(eq(mfpAuthSessions.provider, MFP_PROVIDER))
    .limit(1);

  if (!storedSession) {
    return null;
  }

  return {
    storageState: normalizeStorageState(storedSession.storageState),
    sessionStorage: normalizeSessionStorage(storedSession.sessionStorage),
    authorization: normalizeAuthorization(storedSession.authorization, true),
    cookieHeader: storedSession.cookieHeader?.trim() || null,
  };
}

function requireRefreshCredentials(): void {
  const username = config.mfpUsername?.trim();
  const password = config.mfpPassword?.trim();
  const twoCaptchaApiKey = config.twoCaptchaApiKey?.trim();

  if (!username || !password) {
    throw new Error("MFP_USERNAME and MFP_PASSWORD are required to refresh the MyFitnessPal session.");
  }

  if (!twoCaptchaApiKey) {
    throw new Error("TWO_CAPTCHA_API_KEY is required to refresh the MyFitnessPal session.");
  }
}

async function readDebugState(outputDir: string): Promise<MfpDebugState> {
  const statePath = path.join(outputDir, "state.json");
  const rawState = await readFile(statePath, "utf8");
  const parsedState = JSON.parse(rawState) as MfpDebugState;
  if (!isRecord(parsedState)) {
    throw new Error("MyFitnessPal debug session did not write a valid state file.");
  }
  return parsedState;
}

function summarizeProcessOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!combined) {
    return "no output";
  }

  const lines = combined.split("\n");
  return lines.slice(-12).join("\n");
}

async function refreshWithPlaywright(): Promise<MfpRequestAuth> {
  requireRefreshCredentials();

  const outputDir = await mkdtemp(path.join(os.tmpdir(), "mfp-refresh-"));
  const profileDir = path.join(outputDir, "profile");

  try {
    const child = Bun.spawn({
      cmd: ["bun", "src/providers/myfitnesspal/debug-session.mjs", "run", "submitted"],
      cwd: BACKEND_ROOT,
      env: {
        ...process.env,
        MFP_DEBUG_HEADLESS: config.mfpBrowserHeadless ? "true" : "false",
        MFP_DEBUG_KEEP_OPEN: "0",
        MFP_DEBUG_OUTPUT_DIR: outputDir,
        MFP_DEBUG_PROFILE_DIR: profileDir,
        MFP_DEBUG_RESET_PROFILE: "1",
        MFP_DEBUG_SUBMIT_MODE: "fetch",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`MyFitnessPal refresh script failed (${exitCode}): ${summarizeProcessOutput(stdout, stderr)}`);
    }

    const state = await readDebugState(outputDir);
    const storageState = normalizeStorageState(state.auth?.storageState);
    const sessionStorage = normalizeSessionStorage(state.auth?.sessionStorage);
    const authorization =
      typeof state.auth?.authorization === "string" ? normalizeAuthorization(state.auth.authorization, true) : null;
    const cookieHeader = typeof state.auth?.cookieHeader === "string" ? state.auth.cookieHeader.trim() : "";

    if (!storageState) {
      throw new Error("MyFitnessPal refresh finished without storage state.");
    }

    if (!cookieHeader) {
      throw new Error("MyFitnessPal refresh finished without a cookie header.");
    }

    const now = new Date();

    await db
      .insert(mfpAuthSessions)
      .values({
        provider: MFP_PROVIDER,
        storageState,
        sessionStorage,
        authorization,
        cookieHeader,
        refreshedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: mfpAuthSessions.provider,
        set: {
          storageState,
          sessionStorage,
          authorization,
          cookieHeader,
          refreshedAt: now,
          updatedAt: now,
        },
      });

    return {
      authorization,
      cookieHeader,
    };
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function getMfpAuthHeaders(options: { forceRefresh?: boolean } = {}): Promise<MfpRequestAuth> {
  if (!options.forceRefresh) {
    const storedSession = await readStoredSession();
    if (storedSession?.cookieHeader) {
      return {
        authorization: storedSession.authorization,
        cookieHeader: storedSession.cookieHeader,
      };
    }
  }

  if (!refreshPromise) {
    refreshPromise = refreshWithPlaywright().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}
