import { chromium } from "rebrowser-playwright";
import { solveTurnstileWith2Captcha } from "./mfp-turnstile.mjs";

const LOGIN_URL =
  "https://www.myfitnesspal.com/account/login?callbackUrl=https%3A%2F%2Fwww.myfitnesspal.com%2Ffood%2Fsearch";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.MFP_BROWSER_HEADLESS !== "false",
  proxy: process.env.MFP_PROXY_URL
    ? {
        server: `${new URL(process.env.MFP_PROXY_URL).protocol}//${new URL(process.env.MFP_PROXY_URL).host}`,
        username: decodeURIComponent(new URL(process.env.MFP_PROXY_URL).username),
        password: decodeURIComponent(new URL(process.env.MFP_PROXY_URL).password),
      }
    : undefined,
  args: ["--no-first-run", "--no-default-browser-check"],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
  userAgent: DESKTOP_CHROME_UA,
});
const page = await context.newPage();

context.on("request", (request) => {
  if (request.url().includes("/api/auth/callback/credentials")) {
    console.log("callback request", request.method(), request.url());
    const form = new URLSearchParams(request.postData() ?? "");
    console.log(
      "callback fields",
      JSON.stringify({
        callbackUrl: form.get("callbackUrl"),
        csrfTokenLength: form.get("csrfToken")?.length ?? 0,
        emailLength: form.get("email")?.length ?? 0,
        passwordLength: form.get("password")?.length ?? 0,
        json: form.get("json"),
        turnstileLength: form.get("cf-turnstile-response")?.length ?? 0,
        recaptchaLength: form.get("g-recaptcha-response")?.length ?? 0,
      }),
    );
    console.log(
      "callback headers",
      JSON.stringify({
        contentType: request.headers()["content-type"] ?? null,
        origin: request.headers().origin ?? null,
        referer: request.headers().referer ?? null,
        cookieLength: request.headers().cookie?.length ?? 0,
        userAgent: request.headers()["user-agent"] ?? null,
      }),
    );
  }
});

context.on("response", async (response) => {
  if (response.url().includes("/api/auth/callback/credentials")) {
    console.log("callback response", response.status(), response.url());
    console.log("callback response body", await response.text().catch(() => ""));
  }
});

const readBody = async () => page.locator("body").innerText().catch(() => "");
const inspectForm = async () =>
  page.evaluate(() => {
    const form = document.querySelector("form");
    const elements = [...document.querySelectorAll("input, textarea, select, button")]
      .map((element) => {
        const input = element;
        const value =
          input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement
            ? input.value
            : "";
        return {
          tag: element.tagName.toLowerCase(),
          type: element instanceof HTMLInputElement ? element.type : null,
          name: element.getAttribute("name"),
          id: element.getAttribute("id"),
          disabled: element.hasAttribute("disabled"),
          checked: element instanceof HTMLInputElement ? element.checked : null,
          valueLength: value.length,
          formOwned: form ? form.contains(element) : false,
        };
      })
      .filter((element) => element.name || element.id);
    return {
      formMethod: form?.getAttribute("method") ?? null,
      formAction: form?.getAttribute("action") ?? null,
      elementCount: elements.length,
      elements,
    };
  });

try {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  const okButton = page.getByRole("button", { name: /^ok$/i });
  if ((await okButton.count()) > 0) {
    await okButton.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
  }

  await page.getByLabel(/email address/i).fill(process.env.MFP_USERNAME ?? "");
  await page.getByLabel(/^password$/i).fill(process.env.MFP_PASSWORD ?? "");

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const solved = await solveTurnstileWith2Captcha(page, process.env.TWO_CAPTCHA_API_KEY ?? "", {
    proxyUrl: process.env.MFP_PROXY_URL,
    userAgent,
  });

  console.log("turnstile solved", solved);
  console.log(
    "turnstile token length",
    await page
      .locator('input[name="cf-turnstile-response"]')
      .first()
      .inputValue()
      .catch(() => "")
      .then((value) => value.length),
  );
  console.log("form snapshot", JSON.stringify(await inspectForm()));

  await page.screenshot({ path: "../output/playwright/stripped-after-solve.png", fullPage: true });

  const manualSubmit = await page.evaluate(async () => {
    const emailNode = document.querySelector('input[name="email"]');
    const passwordNode = document.querySelector('input[name="password"]');
    const turnstileNode = document.querySelector('input[name="cf-turnstile-response"]');
    const recaptchaNode = document.querySelector('input[name="g-recaptcha-response"]');
    const email = emailNode instanceof HTMLInputElement ? emailNode.value : "";
    const password = passwordNode instanceof HTMLInputElement ? passwordNode.value : "";
    const turnstile = turnstileNode instanceof HTMLInputElement ? turnstileNode.value : "";
    const recaptcha = recaptchaNode instanceof HTMLInputElement ? recaptchaNode.value : "";
    let csrfToken = "";
    try {
      const csrfResponse = await fetch("https://www.myfitnesspal.com/api/auth/csrf", {
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });
      const csrfJson = await csrfResponse.json();
      csrfToken = typeof csrfJson.csrfToken === "string" ? csrfJson.csrfToken : "";
    } catch {
      csrfToken = "";
    }
    const callbackUrl = "https://www.myfitnesspal.com/food/search";

    const payload = new URLSearchParams({
      callbackUrl,
      csrfToken,
      email,
      password,
      json: "true",
      "cf-turnstile-response": turnstile,
      "g-recaptcha-response": recaptcha,
    });

    const response = await fetch("https://www.myfitnesspal.com/api/auth/callback/credentials", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    });

    return {
      csrfTokenLength: csrfToken.length,
      emailLength: email.length,
      turnstileLength: turnstile.length,
      recaptchaLength: recaptcha.length,
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  });
  console.log("manual submit", JSON.stringify(manualSubmit));

  await page.waitForTimeout(8_000);

  console.log("final url", page.url());
  console.log("body has technical", /technical difficulties/i.test(await readBody()));
  console.log("body has recaptcha", /recaptcha verification failed/i.test(await readBody()));
  console.log(
    "cookies",
    (await context.cookies("https://www.myfitnesspal.com")).map((cookie) => cookie.name).join(","),
  );

  await page.screenshot({ path: "../output/playwright/stripped-after-submit.png", fullPage: true });
} finally {
  await browser.close().catch(() => undefined);
}
