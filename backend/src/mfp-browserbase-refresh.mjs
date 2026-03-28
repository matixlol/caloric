import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright";

const MFP_BASE_URL = "https://www.myfitnesspal.com";
const MFP_SEARCH_URL = `${MFP_BASE_URL}/food/search`;
const MFP_LOGIN_URL = `${MFP_BASE_URL}/account/login?callbackUrl=${encodeURIComponent(MFP_SEARCH_URL)}`;
const MFP_SESSION_ENDPOINT = `${MFP_BASE_URL}/api/auth/session`;
const MFP_REFRESH_TIMEOUT_MS = 60_000;
const MFP_LOGIN_ERROR_PATTERNS = [
  /technical difficulties/i,
  /rate limiting block/i,
  /please try again later/i,
  /invalid email or password/i,
];
const BROWSERBASE_CAPTCHA_TIMEOUT_MS = 35_000;

function normalizeAuthorization(value, allowOpaqueToken = false) {
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

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isAuthorizationLikeKey(key) {
  return /authorization|access[_-]?token|token|auth/i.test(key);
}

function findAuthorizationValue(value, depth = 0, seen = new Set(), parentKey) {
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
      const nested = findAuthorizationValue(item, depth + 1, seen, parentKey);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const key of ["authorization", "auth", "accessToken", "access_token", "token"]) {
    const nested = findAuthorizationValue(value[key], depth + 1, seen, key);
    if (nested) {
      return nested;
    }
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nested = findAuthorizationValue(nestedValue, depth + 1, seen, key);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function cookieMatchesHostname(cookieDomain, hostname) {
  const normalizedDomain = cookieDomain.replace(/^\./, "").toLowerCase();
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === normalizedDomain || normalizedHostname.endsWith(`.${normalizedDomain}`);
}

function buildCookieHeader(storageState) {
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

async function captureSessionStorage(page) {
  return page.evaluate(() => {
    const output = {};
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

async function fetchSessionPayload(page) {
  const result = await page.evaluate(async (endpoint) => {
    try {
      const response = await fetch(endpoint, {
        credentials: "include",
        headers: { Accept: "application/json" },
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

async function dismissConsentModal(page) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const consentFrame = page.frames().find((frame) => frame.url().includes("privacy-mgmt.com"));
    if (!consentFrame) {
      return;
    }

    const okButton = consentFrame.getByRole("button", { name: /^ok$/i });
    if (await okButton.count()) {
      await okButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(750);
      continue;
    }

    const closeButton = consentFrame.getByRole("button", { name: "✕" });
    if (await closeButton.count()) {
      await closeButton.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(750);
      continue;
    }

    await page.waitForTimeout(500);
  }
}

async function readLoginError(page) {
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

async function waitForAuthenticatedPage(page, context) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < MFP_REFRESH_TIMEOUT_MS) {
    if (!new URL(page.url()).pathname.startsWith("/account/login")) {
      return;
    }

    const cookies = await context.cookies(MFP_BASE_URL);
    const hasSessionCookie = cookies.some((cookie) =>
      cookie.name === "__Secure-next-auth.session-token" || cookie.name === "_mfp_session" || cookie.name === "remember_me"
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

async function waitForBrowserbaseCaptcha(page) {
  let solveStarted = false;
  let solveFinished = false;
  const consoleMessages = [];

  const handler = (msg) => {
    const text = msg.text();
    consoleMessages.push(text);
    if (text === "browserbase-solving-started") {
      solveStarted = true;
    }
    if (text === "browserbase-solving-finished") {
      solveFinished = true;
    }
  };

  page.on("console", handler);

  try {
    await page.waitForTimeout(2_000);
    if (!solveStarted) {
      await page.waitForTimeout(3_000);
    }

    if (!solveStarted) {
      return;
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < BROWSERBASE_CAPTCHA_TIMEOUT_MS) {
      if (solveFinished) {
        return;
      }

      await page.waitForTimeout(500);
    }

    const relevantLogs = consoleMessages.filter(
      (message) =>
        message === "browserbase-solving-started" ||
        message === "browserbase-solving-finished" ||
        /turnstile|cloudflare|private access token|failed to load resource|error/i.test(message),
    );

    throw new Error(
      `Browserbase CAPTCHA solving did not finish. Recent logs: ${relevantLogs.slice(-8).join(" | ")}`,
    );
  } finally {
    page.off("console", handler);
  }
}

async function main() {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  const username = process.env.MFP_USERNAME?.trim();
  const password = process.env.MFP_PASSWORD?.trim();

  if (!apiKey) {
    throw new Error("BROWSERBASE_API_KEY is required.");
  }
  if (!username || !password) {
    throw new Error("MFP_USERNAME and MFP_PASSWORD are required.");
  }

  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({
    ...(projectId ? { projectId } : {}),
    timeout: Math.ceil(MFP_REFRESH_TIMEOUT_MS / 1000) + 120,
    browserSettings: {
      solveCaptchas: true,
    },
  });

  const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 120_000 });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Browserbase did not provide a browser context.");
    }

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(MFP_REFRESH_TIMEOUT_MS);

    let capturedAuthorization = null;
    context.on("request", (request) => {
      if (capturedAuthorization) {
        return;
      }

      if (!request.url().includes("myfitnesspal.com")) {
        return;
      }

      capturedAuthorization = normalizeAuthorization(request.headers().authorization) ?? capturedAuthorization;
    });

    await page.goto(MFP_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: MFP_REFRESH_TIMEOUT_MS });
    await waitForBrowserbaseCaptcha(page);
    await dismissConsentModal(page);
    await page.getByLabel(/email address/i).fill(username);
    await page.getByLabel(/^password$/i).fill(password);
    await dismissConsentModal(page);
    await page.getByRole("button", { name: /log in/i }).click({ force: true });
    await waitForBrowserbaseCaptcha(page);
    await waitForAuthenticatedPage(page, context);

    await page.goto(MFP_SEARCH_URL, { waitUntil: "domcontentloaded", timeout: MFP_REFRESH_TIMEOUT_MS });
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
      throw new Error("Failed to capture MyFitnessPal authorization from the Browserbase session.");
    }
    if (!cookieHeader) {
      throw new Error("Failed to capture MyFitnessPal cookies from the Browserbase session.");
    }

    process.stdout.write(JSON.stringify({ storageState, sessionStorage, authorization, cookieHeader }));
  } finally {
    await browser.close();
  }
}

await main();
