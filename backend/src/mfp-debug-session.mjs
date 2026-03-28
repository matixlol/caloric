import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "rebrowser-playwright";
import { installTurnstileHook, solveTurnstileWith2Captcha } from "./mfp-turnstile.mjs";

const BASE_URL = "https://www.myfitnesspal.com";
const SEARCH_URL = `${BASE_URL}/food/search`;
const LOGIN_URL = `${BASE_URL}/account/login?callbackUrl=${encodeURIComponent(SEARCH_URL)}`;
const CALLBACK_URL = `${BASE_URL}/api/auth/callback/credentials`;
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname, "..");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "output", "mfp-debug");
const DEFAULT_PROFILE_DIR = path.join(DEFAULT_OUTPUT_DIR, "profile");

const mode = process.argv[2] ?? process.env.MFP_DEBUG_MODE ?? "run";
const targetStage = process.argv[3] ?? process.env.MFP_DEBUG_STAGE ?? "submitted";
const headless = process.env.MFP_DEBUG_HEADLESS === "true";
const keepOpen = process.env.MFP_DEBUG_KEEP_OPEN === "1";
const resetProfile = process.env.MFP_DEBUG_RESET_PROFILE === "1";
const shouldCheckIp = process.env.MFP_DEBUG_CHECK_IP === "1";
const submitMode = process.env.MFP_DEBUG_SUBMIT_MODE ?? "fetch";
const outputDir = path.resolve(process.env.MFP_DEBUG_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR);
const profileDir = path.resolve(process.env.MFP_DEBUG_PROFILE_DIR ?? DEFAULT_PROFILE_DIR);

function getProxyConfig(proxyUrl) {
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

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
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

async function getIp(page) {
  await page.goto("https://api.ipify.org", { waitUntil: "domcontentloaded", timeout: 60_000 });
  return (await page.textContent("body"))?.trim() ?? "";
}

async function fillCredentials(page) {
  await page.getByLabel(/email address/i).fill(process.env.MFP_USERNAME ?? "");
  await page.getByLabel(/^password$/i).fill(process.env.MFP_PASSWORD ?? "");
  await page.evaluate(
    ({ emailValue, passwordValue }) => {
      const syncReactValue = (selector, value) => {
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
    {
      emailValue: process.env.MFP_USERNAME ?? "",
      passwordValue: process.env.MFP_PASSWORD ?? "",
    },
  );
}

async function solveTurnstile(page) {
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const solved = await solveTurnstileWith2Captcha(page, process.env.TWO_CAPTCHA_API_KEY ?? "", {
    proxyUrl: process.env.MFP_PROXY_URL,
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

async function submitLogin(page) {
  if (submitMode === "native") {
    const submitButton = page.getByRole("button", { name: /log in|login|sign in/i }).first();
    await submitButton.click({ timeout: 10_000, force: true });
    return {
      mode: "native",
    };
  }

  return page.evaluate(
    async ({ callbackEndpoint, callbackUrl }) => {
      const readValue = (selector) => {
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
      callbackEndpoint: CALLBACK_URL,
      callbackUrl: SEARCH_URL,
    },
  );
}

async function inspectPage(page, context) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const cookies = await context.cookies(BASE_URL);

  return {
    bodyHasRecaptcha: /recaptcha verification failed/i.test(bodyText),
    bodyHasTechnical: /technical difficulties/i.test(bodyText),
    bodyHasTemporaryBlock: /temporarily blocked/i.test(bodyText),
    cookies: cookies.map((cookie) => cookie.name),
    url: page.url(),
  };
}

async function inspectForm(page) {
  return page.evaluate(() => {
    const form = document.querySelector("form");
    const elements = [...document.querySelectorAll("input, textarea, select, button")]
      .map((element) => {
        const value =
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
            ? element.value
            : "";

        return {
          checked: element instanceof HTMLInputElement ? element.checked : null,
          disabled: "disabled" in element ? Boolean(element.disabled) : false,
          formOwned: form ? form.contains(element) : false,
          id: element.getAttribute("id"),
          name: element.getAttribute("name"),
          tag: element.tagName.toLowerCase(),
          text:
            element instanceof HTMLButtonElement
              ? element.innerText.trim()
              : element instanceof HTMLInputElement && ["submit", "button"].includes(element.type)
                ? element.value
                : "",
          type: element instanceof HTMLInputElement ? element.type : null,
          valueLength: value.length,
        };
      })
      .filter((element) => element.name || element.id || (element.tag === "button" && element.text));

    return {
      elements,
      formAction: form?.getAttribute("action") ?? null,
      formMethod: form?.getAttribute("method") ?? null,
    };
  });
}

async function inspectTurnstile(page) {
  return page.evaluate(() => {
    const turnstileState = window.__mfpTurnstileState ?? null;
    const container = document.querySelector("#cf-turnstile");
    const parent = container?.parentElement ?? null;
    const reactPropsKey = parent && Object.getOwnPropertyNames(parent).find((key) => key.startsWith("__reactProps$"));
    const reactProps = reactPropsKey ? parent?.[reactPropsKey]?.children?.props ?? null : null;
    const submitButton =
      [...document.querySelectorAll("button")].find((button) => /log in|login|sign in/i.test(button.innerText || "")) ??
      null;

    return {
      callbackType: typeof turnstileState?.callback,
      containerAttributes: container
        ? {
            id: container.getAttribute("id"),
            sitekey: container.getAttribute("data-sitekey"),
            action: container.getAttribute("data-action"),
            cData: container.getAttribute("data-cdata"),
          }
        : null,
      reactProps: reactProps
        ? {
            action: typeof reactProps.action === "string" ? reactProps.action : null,
            cData: typeof reactProps.cData === "string" ? reactProps.cData : null,
            sitekey: typeof reactProps.sitekey === "string" ? reactProps.sitekey : null,
            hasCallback: typeof reactProps.callback === "function",
          }
        : null,
      iframeSources: [...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]')].map((iframe) =>
        iframe.getAttribute("src"),
      ),
      state: turnstileState
        ? {
            action: turnstileState.action ?? null,
            cData: turnstileState.cData ?? null,
            chlPageDataLength: turnstileState.chlPageData?.length ?? 0,
            sitekey: turnstileState.sitekey ?? null,
          }
        : null,
      submitButton: submitButton
        ? {
            ariaDisabled: submitButton.getAttribute("aria-disabled"),
            disabled: submitButton.disabled,
            text: submitButton.innerText.trim(),
            type: submitButton.getAttribute("type"),
          }
        : null,
      tokenLengths: {
        recaptcha:
          document.querySelector('input[name="g-recaptcha-response"]') instanceof HTMLInputElement
            ? document.querySelector('input[name="g-recaptcha-response"]').value.length
            : 0,
        turnstile:
          document.querySelector('input[name="cf-turnstile-response"]') instanceof HTMLInputElement
            ? document.querySelector('input[name="cf-turnstile-response"]').value.length
            : 0,
      },
    };
  });
}

async function saveArtifacts(page, state) {
  await ensureDir(outputDir);
  await page.screenshot({
    path: path.join(outputDir, `${state.stage}.png`),
    fullPage: true,
  });
  await writeFile(path.join(outputDir, "state.json"), JSON.stringify(state, null, 2));
}

async function maybePause(page, state) {
  if (!keepOpen) {
    return;
  }

  console.log(`keeping browser open at stage=${state.stage}`);
  console.log(`profile=${profileDir}`);
  await page.waitForTimeout(3_600_000);
}

async function main() {
  if (resetProfile) {
    await rm(profileDir, { recursive: true, force: true });
    await ensureDir(outputDir);
    await writeFile(path.join(outputDir, ".reset-requested"), `${new Date().toISOString()}\n`);
  }

  await ensureDir(outputDir);
  await ensureDir(profileDir);

  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless,
    proxy: getProxyConfig(process.env.MFP_PROXY_URL),
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    userAgent: DESKTOP_CHROME_UA,
    viewport: { width: 1440, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await installTurnstileHook(page);

  const state = {
    callback: null,
    final: null,
    headless,
    ip: null,
    keepOpen,
    mode,
    profileDir,
    shouldCheckIp,
    stage: "booted",
    submitMode,
    targetStage,
  };

  context.on("request", (request) => {
    if (!request.url().includes("/api/auth/callback/credentials")) {
      return;
    }

    const form = new URLSearchParams(request.postData() ?? "");
    state.callback = {
      request: {
        callbackUrl: form.get("callbackUrl"),
        csrfTokenLength: form.get("csrfToken")?.length ?? 0,
        emailLength: form.get("email")?.length ?? 0,
        passwordLength: form.get("password")?.length ?? 0,
        recaptchaLength: form.get("g-recaptcha-response")?.length ?? 0,
        turnstileLength: form.get("cf-turnstile-response")?.length ?? 0,
        userAgent: request.headers()["user-agent"] ?? null,
      },
    };
  });

  context.on("response", async (response) => {
    if (!response.url().includes("/api/auth/callback/credentials")) {
      return;
    }

    state.callback = {
      ...(state.callback ?? {}),
      response: {
        status: response.status(),
        text: await response.text().catch(() => ""),
      },
    };
  });

  try {
    if (mode === "ip") {
      state.ip = await getIp(page);
      state.stage = "ip";
      console.log(JSON.stringify({ ip: state.ip, profileDir }, null, 2));
      await saveArtifacts(page, state);
      return;
    }

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await dismissConsentModal(page);
    state.stage = "opened";
    if (shouldCheckIp) {
      state.ip = await getIp(page).catch(() => null);
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await dismissConsentModal(page);
    }
    await saveArtifacts(page, state);
    if (targetStage === "opened") {
      await maybePause(page, state);
      return;
    }

    await fillCredentials(page);
    state.stage = "filled";
    state.form = await inspectForm(page);
    await saveArtifacts(page, state);
    if (targetStage === "filled") {
      await maybePause(page, state);
      return;
    }

    state.turnstile = await solveTurnstile(page);
    state.turnstileDetails = await inspectTurnstile(page);
    state.stage = "solved";
    state.form = await inspectForm(page);
    await saveArtifacts(page, state);
    if (targetStage === "solved") {
      await maybePause(page, state);
      return;
    }

    state.submit = await submitLogin(page);
    await page.waitForTimeout(8_000);
    state.stage = "submitted";
    state.form = await inspectForm(page);
    state.final = await inspectPage(page, context);
    await saveArtifacts(page, state);
    console.log(JSON.stringify(state, null, 2));
    await maybePause(page, state);
  } finally {
    await context.close().catch(() => undefined);
  }
}

await main();
