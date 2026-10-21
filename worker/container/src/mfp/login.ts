// MyFitnessPal browser login, ported from
// backend/src/providers/myfitnesspal/debug-session.mjs ("run" mode, stage
// "submitted", fetch submit, fresh profile), the path prod runs today.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "rebrowser-playwright";
import {
  MFP_BASE_URL,
  MfpLoginFailure,
  captureAuthorization,
  findAuthorizationValue,
  getProxyConfig,
  toLoginResult,
  type MfpLoginResult,
} from "./session.ts";
import { installTurnstileHook, solveTurnstileWith2Captcha } from "./turnstile.ts";

const SEARCH_URL = `${MFP_BASE_URL}/food/search`;
const LOGIN_URL = `${MFP_BASE_URL}/account/login?callbackUrl=${encodeURIComponent(SEARCH_URL)}`;
const CALLBACK_URL = `${MFP_BASE_URL}/api/auth/callback/credentials`;
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export type MfpLoginConfig = {
  username: string;
  password: string;
  twoCaptchaApiKey: string;
  proxyUrl: string | undefined;
  headless: boolean;
};

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
      continue;
    }

    const closeButton = consentFrame.getByRole("button", { name: "✕" });
    if ((await closeButton.count()) > 0) {
      await closeButton.click({ timeout: 5_000, force: true }).catch(() => undefined);
      await page.waitForTimeout(750);
      continue;
    }

    return;
  }
}

async function fillCredentials(page: Page, config: MfpLoginConfig): Promise<void> {
  await page.getByLabel(/email address/i).fill(config.username);
  await page.getByLabel(/^password$/i).fill(config.password);
  await page.evaluate(
    ({ emailValue, passwordValue }) => {
      const syncReactValue = (selector: string, value: string) => {
        const node = document.querySelector(selector);
        if (!(node instanceof HTMLInputElement)) {
          return false;
        }

        const prototype = Object.getPrototypeOf(node);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set?.call(node, value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
        node.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };

      syncReactValue('input[name="email"]', emailValue);
      syncReactValue('input[name="password"]', passwordValue);
    },
    { emailValue: config.username, passwordValue: config.password },
  );
}

async function solveTurnstile(page: Page, config: MfpLoginConfig) {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const solved = await solveTurnstileWith2Captcha(page, config.twoCaptchaApiKey, {
    proxyUrl: config.proxyUrl,
    userAgent,
  });
  const tokenLength = await page
    .locator('input[name="cf-turnstile-response"]')
    .first()
    .inputValue()
    .catch(() => "")
    .then((value) => value.length);

  return { solved, tokenLength };
}

async function submitLogin(page: Page) {
  return page.evaluate(
    async ({ callbackEndpoint, callbackUrl }) => {
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
          headers: { Accept: "application/json" },
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
        csrfTokenLength: csrfToken.length,
        ok: response.ok,
        status: response.status,
        turnstileLength: turnstile.length,
      };
    },
    { callbackEndpoint: CALLBACK_URL, callbackUrl: SEARCH_URL },
  );
}

async function inspectPage(page: Page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return {
    bodyHasRecaptcha: /recaptcha verification failed/i.test(bodyText),
    bodyHasTechnical: /technical difficulties/i.test(bodyText),
    bodyHasTemporaryBlock: /temporarily blocked/i.test(bodyText),
    url: page.url(),
  };
}

async function captureSessionStorage(page: Page): Promise<Record<string, string>> {
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

async function fetchSessionPayload(page: Page): Promise<unknown> {
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
  }, `${MFP_BASE_URL}/api/auth/session`);

  if (!result?.ok || !result.text) {
    return null;
  }

  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

export function readLoginConfig(env: Record<string, string | undefined>): MfpLoginConfig {
  const username = env.MFP_USERNAME?.trim();
  const password = env.MFP_PASSWORD?.trim();
  const twoCaptchaApiKey = env.TWO_CAPTCHA_API_KEY?.trim();
  if (!username || !password) {
    throw new MfpLoginFailure("MFP_USERNAME and MFP_PASSWORD are required to refresh the MyFitnessPal session.");
  }
  if (!twoCaptchaApiKey) {
    throw new MfpLoginFailure("TWO_CAPTCHA_API_KEY is required to refresh the MyFitnessPal session.");
  }
  const headless = env.MFP_BROWSER_HEADLESS?.trim().toLowerCase();
  return {
    username,
    password,
    twoCaptchaApiKey,
    proxyUrl: env.MFP_PROXY_URL?.trim() || undefined,
    headless: !headless || ["1", "true", "yes", "on"].includes(headless),
  };
}

export async function launchContext(profileDir: string, options: { headless: boolean; proxyUrl?: string | undefined }) {
  return chromium.launchPersistentContext(profileDir, {
    headless: options.headless,
    proxy: getProxyConfig(options.proxyUrl),
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    userAgent: DESKTOP_CHROME_UA,
    viewport: { width: 1440, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--no-sandbox",
    ],
  });
}

// Runs one login in a fresh profile. `signal` closes the browser, which makes
// any pending Playwright call reject.
export async function loginToMfp(config: MfpLoginConfig, signal?: AbortSignal): Promise<MfpLoginResult> {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "mfp-profile-"));
  let context: BrowserContext | undefined;
  const onAbort = () => void context?.close().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    context = await launchContext(profileDir, config);
    if (signal?.aborted) {
      throw new MfpLoginFailure("MyFitnessPal login was aborted.");
    }
    const page = context.pages()[0] ?? (await context.newPage());
    await installTurnstileHook(page);
    let capturedAuthorization: string | null = null;
    let callbackStatus: number | null = null;

    context.on("request", (request) => {
      if (!capturedAuthorization && request.url().includes("myfitnesspal.com")) {
        capturedAuthorization = captureAuthorization(request.headers().authorization) ?? capturedAuthorization;
      }
    });
    context.on("response", (response) => {
      if (response.url().includes("/api/auth/callback/credentials")) {
        callbackStatus = response.status();
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await dismissConsentModal(page);
    console.log("mfp.login stage=opened");

    await fillCredentials(page, config);
    console.log("mfp.login stage=filled");

    const turnstile = await solveTurnstile(page, config);
    console.log(`mfp.login stage=solved solved=${turnstile.solved} tokenLength=${turnstile.tokenLength}`);

    const submit = await submitLogin(page);
    await page.waitForTimeout(8_000);
    const final = await inspectPage(page);
    console.log(
      `mfp.login stage=submitted status=${submit.status} callbackStatus=${callbackStatus} url=${final.url} ` +
        `blocked=${final.bodyHasTemporaryBlock} recaptcha=${final.bodyHasRecaptcha} technical=${final.bodyHasTechnical}`,
    );

    const storageState = await context.storageState();
    const sessionStorage = await captureSessionStorage(page);
    const sessionPayload = await fetchSessionPayload(page);
    const authorization =
      capturedAuthorization ??
      findAuthorizationValue(sessionPayload) ??
      findAuthorizationValue(storageState) ??
      findAuthorizationValue(sessionStorage);

    return toLoginResult({ authorization, storageState, sessionStorage });
  } catch (error) {
    if (signal?.aborted) {
      throw new MfpLoginFailure(`MyFitnessPal login timed out: ${String(signal.reason ?? "aborted")}`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context?.close().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
