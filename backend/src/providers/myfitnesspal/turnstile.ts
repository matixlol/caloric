import type { Page } from "rebrowser-playwright";

type TurnstileState = {
  sitekey: string | null;
  action: string | null;
  cData: string | null;
  chlPageData: string | null;
};

const MFP_TURNSTILE_FALLBACK_SITEKEY = "0x4AAAAAAAL9xc7OWtF5IST-";
const TWO_CAPTCHA_SUBMIT_URL = "https://2captcha.com/in.php";
const TWO_CAPTCHA_RESULT_URL = "https://2captcha.com/res.php";
const TWO_CAPTCHA_TIMEOUT_MS = 180_000;
const TWO_CAPTCHA_POLL_INTERVAL_MS = 5_000;

export async function installTurnstileHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: {
      sitekey: string | null;
      action: string | null;
      cData: string | null;
      chlPageData: string | null;
      callback: ((token: string) => void | Promise<void>) | null;
    } = {
      sitekey: null,
      action: null,
      cData: null,
      chlPageData: null,
      callback: null,
    };

    (window as { __mfpTurnstileState?: typeof state }).__mfpTurnstileState = state;

    const wrapTurnstile = (turnstile: { render?: unknown } | undefined) => {
      if (!turnstile || typeof turnstile.render !== "function") {
        return false;
      }

      const currentRender = turnstile.render as ((container: unknown, options?: Record<string, unknown>) => unknown) & {
        __mfpWrapped?: boolean;
      };
      if (currentRender.__mfpWrapped) {
        return true;
      }

      const originalRender = currentRender.bind(turnstile);
      const wrappedRender = ((container: unknown, options: Record<string, unknown> = {}) => {
        const containerElement =
          typeof container === "string"
            ? document.querySelector(container)
            : container instanceof Element
              ? container
              : null;
        const sharedState = (window as { __mfpTurnstileState?: typeof state }).__mfpTurnstileState ?? state;

        sharedState.sitekey =
          typeof options.sitekey === "string"
            ? options.sitekey
            : containerElement?.getAttribute("data-sitekey") ?? sharedState.sitekey;
        sharedState.action =
          typeof options.action === "string"
            ? options.action
            : containerElement?.getAttribute("data-action") ?? sharedState.action;
        sharedState.cData =
          typeof options.cData === "string"
            ? options.cData
            : containerElement?.getAttribute("data-cdata") ?? sharedState.cData;
        sharedState.chlPageData =
          typeof options.chlPageData === "string" ? options.chlPageData : sharedState.chlPageData;
        sharedState.callback =
          typeof options.callback === "function"
            ? (options.callback as (token: string) => void | Promise<void>)
            : sharedState.callback;

        (window as { __mfpTurnstileState?: typeof state }).__mfpTurnstileState = sharedState;

        return originalRender(container, options);
      }) as typeof currentRender;

      wrappedRender.__mfpWrapped = true;
      turnstile.render = wrappedRender;

      return true;
    };

    let turnstileValue = (window as { turnstile?: { render?: unknown } }).turnstile;
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      get() {
        return turnstileValue;
      },
      set(value) {
        turnstileValue = value as { render?: unknown } | undefined;
        wrapTurnstile(turnstileValue);
      },
    });

    let onloadCallback: unknown;
    Object.defineProperty(window, "onloadTurnstileCallback", {
      configurable: true,
      get() {
        return onloadCallback;
      },
      set(value) {
        if (typeof value !== "function") {
          onloadCallback = value;
          return;
        }

        onloadCallback = (...args: unknown[]) => {
          wrapTurnstile(turnstileValue);
          return (value as (...callbackArgs: unknown[]) => unknown)(...args);
        };
      },
    });

    if (wrapTurnstile(turnstileValue)) {
      return;
    }

    const interval = window.setInterval(() => {
      if (wrapTurnstile(turnstileValue)) {
        window.clearInterval(interval);
      }
    }, 50);

    window.setTimeout(() => window.clearInterval(interval), 10_000);
  });
}

async function readTurnstileState(page: Page): Promise<TurnstileState | null> {
  return page.evaluate((fallbackSitekey: string) => {
    const state = (window as {
      __mfpTurnstileState?: {
        sitekey?: string | null;
        action?: string | null;
        cData?: string | null;
        chlPageData?: string | null;
      };
    }).__mfpTurnstileState;
    const turnstileNode = document.querySelector("#cf-turnstile");
    const container = document.querySelector("[data-sitekey]");
    const reactPropsKey =
      turnstileNode?.parentElement &&
      Object.getOwnPropertyNames(turnstileNode.parentElement).find((key) => key.startsWith("__reactProps$"));
    const reactChild =
      reactPropsKey && turnstileNode?.parentElement
        ? ((turnstileNode.parentElement as unknown as Record<string, unknown>)[reactPropsKey] as
            | { children?: { props?: { action?: string | null; cData?: string | null } } }
            | undefined)
        : undefined;
    const sitekey =
      state?.sitekey ??
      container?.getAttribute("data-sitekey") ??
      (turnstileNode ? fallbackSitekey : null);

    if (!sitekey) {
      return null;
    }

    return {
      sitekey,
      action:
        state?.action ??
        container?.getAttribute("data-action") ??
        (typeof reactChild?.children?.props?.action === "string" ? reactChild.children.props.action : null),
      cData:
        state?.cData ??
        container?.getAttribute("data-cdata") ??
        (typeof reactChild?.children?.props?.cData === "string" ? reactChild.children.props.cData : null),
      chlPageData: state?.chlPageData ?? null,
    };
  }, MFP_TURNSTILE_FALLBACK_SITEKEY);
}

async function readTurnstileToken(page: Page): Promise<string> {
  return page
    .locator('input[name="cf-turnstile-response"]')
    .first()
    .inputValue()
    .catch(() => "");
}

async function ensureTurnstileRendered(page: Page, state: TurnstileState): Promise<void> {
  await page.evaluate((fallbackState: TurnstileState) => {
    const existingInput = document.querySelector('input[name="cf-turnstile-response"]');
    const existingIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (existingInput || existingIframe) {
      return;
    }

    const container = document.querySelector("#cf-turnstile");
    const turnstile = (window as { turnstile?: { render?: unknown } }).turnstile;
    if (!(container instanceof HTMLElement) || typeof turnstile?.render !== "function") {
      return;
    }

    if (container.dataset.mfpRendered === "1") {
      return;
    }

    const reactPropsKey =
      container.parentElement &&
      Object.getOwnPropertyNames(container.parentElement).find((key) => key.startsWith("__reactProps$"));
    const reactOptions =
      reactPropsKey && container.parentElement
        ? ((container.parentElement as unknown as Record<string, unknown>)[reactPropsKey] as
            | { children?: { props?: Record<string, unknown> } }
            | undefined)?.children?.props
        : undefined;

    const options = {
      ...(reactOptions ?? {}),
      sitekey:
        (typeof reactOptions?.sitekey === "string" ? reactOptions.sitekey : null) ?? fallbackState.sitekey ?? undefined,
      action:
        (typeof reactOptions?.action === "string" ? reactOptions.action : null) ?? fallbackState.action ?? undefined,
      cData:
        (typeof reactOptions?.cData === "string" ? reactOptions.cData : null) ?? fallbackState.cData ?? undefined,
    };

    container.dataset.mfpRendered = "1";
    turnstile.render(container, options);
  }, state);

  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector('input[name="cf-turnstile-response"]') ||
            document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        ),
      { timeout: 10_000 },
    )
    .catch(() => undefined);
}

async function requestTurnstileToken(
  apiKey: string,
  state: TurnstileState,
  pageUrl: string,
  options: {
    proxyUrl?: string | null;
    userAgent?: string;
  } = {},
): Promise<string> {
  if (!state.sitekey) {
    throw new Error("Turnstile sitekey was not found.");
  }

  const payload = new URLSearchParams({
    key: apiKey,
    method: "turnstile",
    sitekey: state.sitekey,
    pageurl: pageUrl,
    json: "1",
  });

  if (state.action) {
    payload.set("action", state.action);
  }
  if (state.cData) {
    payload.set("data", state.cData);
  }
  if (state.chlPageData) {
    payload.set("pagedata", state.chlPageData);
  }
  if (options.userAgent) {
    payload.set("userAgent", options.userAgent);
  }

  const proxy = normalize2CaptchaProxy(options.proxyUrl);
  if (proxy) {
    payload.set("proxy", proxy.proxy);
    payload.set("proxytype", proxy.proxyType);
  }

  const submitResponse = await fetch(TWO_CAPTCHA_SUBMIT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload,
  });
  const submitJson = (await submitResponse.json()) as { status?: number; request?: unknown };
  if (submitJson.status !== 1 || typeof submitJson.request !== "string") {
    throw new Error(`2Captcha submission failed: ${String(submitJson.request ?? submitResponse.statusText)}`);
  }

  const requestId = submitJson.request;
  const startedAt = Date.now();

  while (Date.now() - startedAt < TWO_CAPTCHA_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, TWO_CAPTCHA_POLL_INTERVAL_MS));

    const resultUrl = new URL(TWO_CAPTCHA_RESULT_URL);
    resultUrl.search = new URLSearchParams({
      key: apiKey,
      action: "get",
      id: requestId,
      json: "1",
    }).toString();

    const resultResponse = await fetch(resultUrl);
    const resultJson = (await resultResponse.json()) as { status?: number; request?: unknown };
    if (resultJson.status === 1 && typeof resultJson.request === "string") {
      return resultJson.request;
    }

    const message = String(resultJson.request ?? resultResponse.statusText);
    if (message !== "CAPCHA_NOT_READY" && message !== "CAPTCHA_NOT_READY") {
      throw new Error(`2Captcha solve failed: ${message}`);
    }
  }

  throw new Error("2Captcha solve timed out.");
}

function normalize2CaptchaProxy(proxyUrl: string | null | undefined): { proxy: string; proxyType: string } | null {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new URL(trimmed);
  const protocol = parsed.protocol.replace(":", "").toUpperCase();
  const proxyType = protocol === "HTTPS" ? "HTTP" : protocol;
  const credentials =
    parsed.username || parsed.password
      ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@`
      : "";

  return {
    proxy: `${credentials}${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`,
    proxyType,
  };
}

async function applyTurnstileToken(page: Page, token: string): Promise<void> {
  await page.evaluate(async (resolvedToken: string) => {
    const ensureFields = (name: string) => {
      const existing = [...document.querySelectorAll(`input[name="${name}"], textarea[name="${name}"]`)].filter(
        (element): element is HTMLInputElement | HTMLTextAreaElement =>
          element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement,
      );
      if (existing.length > 0) {
        return existing;
      }

      const target = document.querySelector("form") ?? document.body;
      const created = document.createElement("input");
      created.type = "hidden";
      created.name = name;
      target.appendChild(created);
      return [created];
    };

    for (const element of ensureFields("cf-turnstile-response")) {
      element.value = resolvedToken;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const state = (window as {
      __mfpTurnstileState?: {
        callback?: ((token: string) => void | Promise<void>) | null;
      };
    }).__mfpTurnstileState;
    if (typeof state?.callback === "function") {
      await Promise.resolve(state.callback(resolvedToken));
    }
  }, token);
}

export async function solveTurnstileWith2Captcha(
  page: Page,
  apiKey: string,
  options: { proxyUrl?: string | null; userAgent?: string } = {},
): Promise<boolean> {
  const existingToken = await readTurnstileToken(page);
  if (existingToken.trim()) {
    return true;
  }

  const state = await readTurnstileState(page);
  if (!state) {
    return false;
  }

  await ensureTurnstileRendered(page, state);

  const token = await requestTurnstileToken(apiKey, state, page.url(), options);
  await applyTurnstileToken(page, token);

  await page.waitForFunction(
    () => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return !(input instanceof HTMLInputElement) || input.value.trim().length > 0;
    },
    { timeout: 10_000 },
  );

  return true;
}
