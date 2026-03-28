import playwright from "playwright-core";

const chromium = playwright.chromium;

const MFP_BASE_URL = "https://www.myfitnesspal.com";
const MFP_SEARCH_URL = `${MFP_BASE_URL}/food/search`;
const MFP_LOGIN_URL = `${MFP_BASE_URL}/account/login?callbackUrl=${encodeURIComponent(MFP_SEARCH_URL)}`;
const MFP_AUTH_CALLBACK_URL = `${MFP_BASE_URL}/api/auth/callback/credentials`;
const MFP_SESSION_ENDPOINT = `${MFP_BASE_URL}/api/auth/session`;
const MFP_REFRESH_TIMEOUT_MS = 60_000;
const MFP_LOGIN_ERROR_PATTERNS = [
  /technical difficulties/i,
  /rate limiting block/i,
  /please try again later/i,
  /invalid email or password/i,
  /recaptcha verification failed/i,
];

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

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
      const nested = findAuthorizationValue(item, depth + 1, seen);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  const priorityKeys = ["authorization", "auth", "accessToken", "access_token", "token"];
  for (const key of priorityKeys) {
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

async function dismissConsentModal(page) {
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

    if (page.frames().filter((frame) => frame.url().includes("privacy-mgmt.com")).length === 0) {
      return;
    }
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
  const getActivePage = () => {
    const openPages = context.pages().filter((currentPage) => !currentPage.isClosed());
    return openPages.at(-1) ?? page;
  };

  while (Date.now() - startedAt < MFP_REFRESH_TIMEOUT_MS) {
    const activePage = getActivePage();
    const activeUrl = activePage.isClosed() ? "" : activePage.url();
    if (activeUrl && !new URL(activeUrl).pathname.startsWith("/account/login")) {
      return;
    }

    const cookies = await context.cookies(MFP_BASE_URL);
    const hasSessionCookie = cookies.some((cookie) =>
      cookie.name === "__Secure-next-auth.session-token" || cookie.name === "_mfp_session" || cookie.name === "remember_me"
    );
    if (hasSessionCookie) {
      return;
    }

    if (!activePage.isClosed()) {
      const loginError = await readLoginError(activePage);
      if (loginError) {
        throw new Error(`MyFitnessPal login was blocked: ${loginError}`);
      }
    }

    if (activePage.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } else {
      await activePage.waitForTimeout(1_000);
    }
  }

  throw new Error("Timed out waiting for MyFitnessPal login to complete.");
}

async function waitForBrowserlessCaptchaSolve(page, cdpSession, captchaState) {
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector("#cf-turnstile") ||
            document.querySelector('input[name="cf-turnstile-response"]') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        ),
      { timeout: 20_000 },
    )
    .catch(() => undefined);

  const turnstilePresent =
    (await page.locator('#cf-turnstile, input[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com"]').count()) >
    0;
  if (!turnstilePresent && !captchaState.found) {
    return;
  }

  const startedAt = Date.now();
  let manualSolveRequested = false;

  while (Date.now() - startedAt < 45_000) {
    if (captchaState.solved) {
      await page
        .waitForFunction(
          () => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return !(input instanceof HTMLInputElement) || input.value.trim().length > 0;
          },
          { timeout: 8_000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      return;
    }

    if (captchaState.error) {
      throw new Error(`Browserless CAPTCHA solve failed: ${captchaState.error}`);
    }

    if (captchaState.found && !manualSolveRequested) {
      manualSolveRequested = true;
      await cdpSession.send("Browserless.solveCaptcha").catch(() => undefined);
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for Browserless CAPTCHA solve to complete.");
}

async function submitLoginForm(page, context) {
  const waitForCallbackRequest = () =>
    context
      .waitForEvent("request", {
        predicate: (request) => request.method() === "POST" && request.url().startsWith(MFP_AUTH_CALLBACK_URL),
        timeout: 10_000,
      })
      .then(() => true)
      .catch(() => false);

  let submitted = waitForCallbackRequest();
  await page.evaluate(() => {
    const form = document.querySelector("form");
    if (form instanceof HTMLFormElement) {
      form.requestSubmit();
    }
  });
  if (await submitted) {
    return;
  }

  submitted = waitForCallbackRequest();
  await page.getByRole("button", { name: /log in/i }).click({ force: true }).catch(() => undefined);
  await submitted;
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

async function main() {
  const token = requireEnv("BROWSERLESS_API_TOKEN");
  const username = requireEnv("MFP_USERNAME");
  const password = requireEnv("MFP_PASSWORD");
  const endpoint =
    `wss://production-sfo.browserless.io/chrome/stealth?token=${encodeURIComponent(token)}` +
    "&proxy=residential&proxyCountry=us&proxySticky&proxyLocaleMatch=1&solveCaptchas=true";
  const browser = await chromium.connectOverCDP(endpoint, {
    timeout: 120_000,
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error("Browserless did not return a browser context.");
  }

  const page = context.pages()[0] ?? (await context.newPage());
  const getActivePage = () => {
    const openPages = context.pages().filter((currentPage) => !currentPage.isClosed());
    return openPages.at(-1) ?? page;
  };
  const cdpSession = await context.newCDPSession(page);
  const captchaState = {
    error: null,
    found: false,
    solved: false,
    token: null,
  };
  let capturedAuthorization = null;

  cdpSession.on("Browserless.captchaFound", () => {
    captchaState.found = true;
  });
  cdpSession.on("Browserless.captchaAutoSolved", (event) => {
    captchaState.error = typeof event.error === "string" ? event.error : null;
    captchaState.solved = event.solved === true;
    captchaState.token = typeof event.token === "string" ? event.token : null;
  });

  context.on("request", (request) => {
    if (capturedAuthorization) {
      return;
    }

    if (!request.url().includes("myfitnesspal.com")) {
      return;
    }

    capturedAuthorization = normalizeAuthorization(request.headers().authorization) ?? capturedAuthorization;
  });

  try {
    page.setDefaultTimeout(MFP_REFRESH_TIMEOUT_MS);

    await page.goto(MFP_LOGIN_URL, {
      timeout: MFP_REFRESH_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await dismissConsentModal(page);

    await page.getByLabel(/email address/i).fill(username);
    await page.getByLabel(/^password$/i).fill(password);
    await waitForBrowserlessCaptchaSolve(page, cdpSession, captchaState);
    await dismissConsentModal(page);

    await submitLoginForm(page, context);
    await waitForAuthenticatedPage(page, context);

    await getActivePage().goto(MFP_SEARCH_URL, {
      timeout: MFP_REFRESH_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    await getActivePage().waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    const storageState = await context.storageState();
    const sessionStorage = await captureSessionStorage(getActivePage());
    const sessionPayload = await fetchSessionPayload(getActivePage());
    const authorization =
      capturedAuthorization ??
      findAuthorizationValue(sessionPayload) ??
      findAuthorizationValue(storageState) ??
      findAuthorizationValue(sessionStorage);
    const cookieHeader = buildCookieHeader(storageState);

    if (!authorization) {
      throw new Error("Failed to capture MyFitnessPal authorization from the Browserless session.");
    }

    if (!cookieHeader) {
      throw new Error("Failed to capture MyFitnessPal cookies from the Browserless session.");
    }

    process.stdout.write(
      JSON.stringify({
        authorization,
        cookieHeader,
        sessionStorage,
        storageState,
      }),
    );
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
