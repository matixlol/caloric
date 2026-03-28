import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "rebrowser-playwright";
import { chromium } from "rebrowser-playwright";
import { config } from "./config";
import { db } from "./db";
import { mfpAuthSessions } from "./db/schema";
import { installTurnstileHook, solveTurnstileWith2Captcha } from "./mfp-turnstile";

export const MFP_BASE_URL = "https://www.myfitnesspal.com";

const MFP_PROVIDER = "myfitnesspal";
const MFP_SEARCH_URL = `${MFP_BASE_URL}/food/search`;
const MFP_LOGIN_URL = `${MFP_BASE_URL}/account/login?callbackUrl=${encodeURIComponent(MFP_SEARCH_URL)}`;
const MFP_AUTH_CALLBACK_URL = `${MFP_BASE_URL}/api/auth/callback/credentials`;
const MFP_SESSION_ENDPOINT = `${MFP_BASE_URL}/api/auth/session`;
const MFP_REFRESH_TIMEOUT_MS = 60_000;
const MFP_TURNSTILE_TIMEOUT_MS = 20_000;
const DESKTOP_CHROME_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const MFP_LOGIN_ERROR_PATTERNS = [
  /technical difficulties/i,
  /rate limiting block/i,
  /please try again later/i,
  /invalid email or password/i,
  /recaptcha verification failed/i,
  /temporarily blocked/i,
  /allowed timeframe/i,
];

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

export type MfpRequestAuth = {
  authorization: string;
  cookieHeader: string;
};

type BrowserSessionHandle = {
  browser: Browser | null;
  context: BrowserContext;
  page: Page;
  profileDir: string;
};

type SubmitResult = {
  bodyText: string;
  csrfTokenLength: number;
  emailLength: number;
  ok: boolean;
  recaptchaLength: number;
  status: number;
  turnstileLength: number;
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

function normalizeAuthorization(value: string | null | undefined, allowOpaqueToken = false): string | null {
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

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAuthorizationLikeKey(key: string): boolean {
  return /authorization|access[_-]?token|token|auth/i.test(key);
}

function findAuthorizationValue(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
  parentKey?: string,
): string | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const direct = normalizeAuthorization(value, Boolean(parentKey && isAuthorizationLikeKey(parentKey)));
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

  const priorityKeys = ["authorization", "auth", "accessToken", "access_token", "token"];
  for (const key of priorityKeys) {
    const nested = findAuthorizationValue((value as Record<string, unknown>)[key], depth + 1, seen, key);
    if (nested) {
      return nested;
    }
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
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

function buildCookieHeader(storageState: MfpStorageState): string | null {
  const hostname = new URL(MFP_BASE_URL).hostname;
  const nowSeconds = Date.now() / 1000;
  const cookies = storageState.cookies.filter((cookie) => {
    if (!cookie.name || !cookie.value) {
      return false;
    }

    if (!cookieMatchesHostname(cookie.domain, hostname)) {
      return false;
    }

    return cookie.expires === -1 || cookie.expires > nowSeconds;
  });

  if (cookies.length === 0) {
    return null;
  }

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
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
    authorization: normalizeAuthorization(storedSession.authorization),
    cookieHeader: storedSession.cookieHeader?.trim() || null,
  };
}

function requireRefreshCredentials(): { username: string; password: string } {
  const username = config.mfpUsername?.trim();
  const password = config.mfpPassword?.trim();

  if (!username || !password) {
    throw new Error("MFP_USERNAME and MFP_PASSWORD are required to refresh the MyFitnessPal session.");
  }

  return { username, password };
}

function parseProxyConfig(proxyUrl: string | null | undefined):
  | {
      password?: string;
      server: string;
      username?: string;
    }
  | undefined {
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

async function createLocalStealthSession(): Promise<BrowserSessionHandle> {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "mfp-session-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: config.mfpBrowserHeadless,
    proxy: parseProxyConfig(config.mfpProxyUrl),
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    userAgent: DESKTOP_CHROME_USER_AGENT,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const browser = context.browser();
  const page = context.pages()[0] ?? (await context.newPage());
  await installTurnstileHook(page);

  return {
    browser,
    context,
    page,
    profileDir,
  };
}

async function captureSessionStorage(page: Page): Promise<SessionStorageState> {
  return page.evaluate(() => {
    const output: Record<string, string> = {};
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (!key) {
        continue;
      }

      const value = window.sessionStorage.getItem(key);
      if (value !== null) {
        output[key] = value;
      }
    }
    return output;
  });
}

async function fetchSessionPayload(page: Page): Promise<unknown | null> {
  const result = await page.evaluate(async (endpoint: string) => {
    try {
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });

      return {
        ok: response.ok,
        text: await response.text(),
      };
    } catch {
      return null;
    }
  }, MFP_SESSION_ENDPOINT);

  if (!result?.ok || !result.text) {
    return null;
  }

  return tryParseJson(result.text);
}

async function maybeSolveTurnstile(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector('input[name="cf-turnstile-response"]') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        ),
      { timeout: 15_000 },
    )
    .catch(() => undefined);

  const widget = page.locator('input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]');
  if ((await widget.count()) === 0) {
    return;
  }

  const tokenInput = page.locator('input[name="cf-turnstile-response"]');
  const tokenInputCount = await tokenInput.count();
  const initialValue = tokenInputCount > 0 ? await tokenInput.first().inputValue().catch(() => "") : "";
  if (initialValue.trim()) {
    return;
  }

  const frame = page.locator('iframe[src*="challenges.cloudflare.com"]');
  if ((await frame.count()) > 0) {
    const box = await frame.first().boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 150 });
      await page
        .waitForFunction(
          () => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return input instanceof HTMLInputElement && input.value.trim().length > 0;
          },
          { timeout: 8_000 },
        )
        .catch(() => undefined);
      const clickedValue = await tokenInput.first().inputValue().catch(() => "");
      if (clickedValue.trim()) {
        return;
      }
    }
  }

  const twoCaptchaApiKey = config.twoCaptchaApiKey?.trim();
  if (twoCaptchaApiKey) {
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => undefined);
    const solved = await solveTurnstileWith2Captcha(page, twoCaptchaApiKey, {
      proxyUrl: config.mfpProxyUrl,
      userAgent,
    });
    if (solved) {
      return;
    }
  }

  await page
    .waitForFunction(
      () => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        return !(input instanceof HTMLInputElement) || input.value.trim().length > 0;
      },
      { timeout: MFP_TURNSTILE_TIMEOUT_MS },
    )
    .catch(() => undefined);
}

async function dismissConsentModal(page: Page): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10_000) {
    const consentFrame = page.frames().find((frame) => frame.url().includes("privacy-mgmt.com"));
    if (!consentFrame) {
      return;
    }

    const okButton = consentFrame.getByRole("button", { name: /^ok$/i });
    if ((await okButton.count()) > 0) {
      await okButton.click({ timeout: 5_000, force: true }).catch(() => undefined);
      await page.waitForTimeout(750);
    } else {
      const closeButton = consentFrame.getByRole("button", { name: "✕" });
      if ((await closeButton.count()) > 0) {
        await closeButton.click({ timeout: 5_000, force: true }).catch(() => undefined);
        await page.waitForTimeout(750);
      }
    }

    const consentIframes = page.frames().filter((frame) => frame.url().includes("privacy-mgmt.com"));
    if (consentIframes.length === 0) {
      return;
    }
  }
}

async function readLoginError(page: Page): Promise<string | null> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const normalized = bodyText.trim();
  if (!normalized) {
    return null;
  }

  for (const pattern of MFP_LOGIN_ERROR_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function summarizeCallbackFailure(result: SubmitResult): string {
  const bodyText = result.bodyText.replace(/\s+/g, " ").trim();
  const blocked = bodyText.match(/temporarily blocked/i);
  const rateLimit = bodyText.match(/rate limiting block/i);
  const recaptcha = bodyText.match(/recaptcha verification failed/i);
  const technical = bodyText.match(/technical difficulties/i);
  const timeframe = bodyText.match(/allowed timeframe/i);
  const reason =
    blocked?.[0] ?? rateLimit?.[0] ?? recaptcha?.[0] ?? technical?.[0] ?? timeframe?.[0] ?? `HTTP ${result.status}`;

  return `${reason} (csrf=${result.csrfTokenLength}, email=${result.emailLength}, turnstile=${result.turnstileLength})`;
}

async function submitLoginForm(page: Page): Promise<void> {
  const result = await page.evaluate(
    async ({
      callbackEndpoint,
      callbackUrl,
    }: {
      callbackEndpoint: string;
      callbackUrl: string;
    }) => {
      const readValue = (selector: string) => {
        const node = document.querySelector(selector);
        return node instanceof HTMLInputElement ? node.value : "";
      };

      const email = readValue('input[name="email"]');
      const password = readValue('input[name="password"]');
      const turnstile = readValue('input[name="cf-turnstile-response"]');

      let csrfToken = "";
      try {
        const csrfResponse = await fetch("https://www.myfitnesspal.com/api/auth/csrf", {
          credentials: "include",
          headers: {
            Accept: "application/json",
          },
        });
        const csrfJson = await csrfResponse.json();
        csrfToken = typeof csrfJson?.csrfToken === "string" ? csrfJson.csrfToken : "";
      } catch {
        csrfToken = "";
      }

      const payload = new URLSearchParams({
        callbackUrl,
        csrfToken,
        username: email,
        password,
        json: "true",
        redirect: "false",
        turnstile_token: turnstile,
      });

      const response = await fetch(callbackEndpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload.toString(),
      });

      return {
        bodyText: await response.text(),
        csrfTokenLength: csrfToken.length,
        emailLength: email.length,
        ok: response.ok,
        recaptchaLength: 0,
        status: response.status,
        turnstileLength: turnstile.length,
      };
    },
    {
      callbackEndpoint: MFP_AUTH_CALLBACK_URL,
      callbackUrl: MFP_SEARCH_URL,
    },
  );

  if (!result.ok) {
    throw new Error(`MyFitnessPal login callback failed: ${summarizeCallbackFailure(result)}`);
  }
}

async function waitForAuthenticatedPage(page: Page, context: BrowserContext): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MFP_REFRESH_TIMEOUT_MS) {
    const cookies = await context.cookies(MFP_BASE_URL);
    const hasSessionCookie = cookies.some(
      (cookie) =>
        cookie.name === "__Secure-next-auth.session-token" ||
        cookie.name === "_mfp_session" ||
        cookie.name === "remember_me",
    );
    if (hasSessionCookie) {
      return;
    }

    const loginError = await readLoginError(page);
    if (loginError) {
      throw new Error(`MyFitnessPal login was blocked: ${loginError}`);
    }

    await page.waitForTimeout(1_000);
  }

  throw new Error("Timed out waiting for MyFitnessPal login to complete.");
}

async function refreshWithPlaywright(): Promise<MfpRequestAuth> {
  const credentials = requireRefreshCredentials();
  const { browser, context, page, profileDir } = await createLocalStealthSession();

  try {
    let capturedAuthorization: string | null = null;

    context.on("request", (request) => {
      if (capturedAuthorization || !request.url().includes("myfitnesspal.com")) {
        return;
      }

      capturedAuthorization = normalizeAuthorization(request.headers().authorization) ?? capturedAuthorization;
    });
    page.setDefaultTimeout(MFP_REFRESH_TIMEOUT_MS);

    await page.goto(MFP_LOGIN_URL, {
      timeout: MFP_REFRESH_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await dismissConsentModal(page);

    await page.getByLabel(/email address/i).fill(credentials.username);
    await page.getByLabel(/^password$/i).fill(credentials.password);
    await maybeSolveTurnstile(page);
    await dismissConsentModal(page);
    await submitLoginForm(page);
    await waitForAuthenticatedPage(page, context);

    await page.goto(MFP_SEARCH_URL, {
      timeout: MFP_REFRESH_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    const storageState = await context.storageState();
    const sessionStorage = await captureSessionStorage(page);
    const sessionPayload = await fetchSessionPayload(page);
    const authorization =
      capturedAuthorization ??
      findAuthorizationValue(sessionPayload) ??
      findAuthorizationValue(storageState) ??
      findAuthorizationValue(sessionStorage);
    const cookieHeader = buildCookieHeader(storageState);

    if (!authorization) {
      throw new Error("Failed to capture MyFitnessPal authorization from the refreshed browser session.");
    }

    if (!cookieHeader) {
      throw new Error("Failed to capture MyFitnessPal cookies from the refreshed browser session.");
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
    await context.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function getMfpAuthHeaders(options: { forceRefresh?: boolean } = {}): Promise<MfpRequestAuth> {
  if (!options.forceRefresh) {
    const storedSession = await readStoredSession();
    if (storedSession?.authorization && storedSession.cookieHeader) {
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
