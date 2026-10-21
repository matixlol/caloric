import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

export const CONTAINER_PORT = 8080;

// Chromium (MyFitnessPal login) + ffmpeg (voice notes), built from
// worker/container. standard-1 = 1/2 vCPU, 4 GiB: Chromium on "basic"
// (1/4 vCPU) is too slow for the login page's timeouts.
export class MfpContainer extends Cloudflare.Container<MfpContainer>()(
  "MfpContainer",
  Effect.gen(function* () {
    // Optional so stages without MFP credentials still deploy; the container
    // then fails each login with a clear message.
    const secrets = {
      MFP_USERNAME: yield* Config.option(Config.Redacted("MFP_USERNAME")),
      MFP_PASSWORD: yield* Config.option(Config.Redacted("MFP_PASSWORD")),
      TWO_CAPTCHA_API_KEY: yield* Config.option(Config.Redacted("TWO_CAPTCHA_API_KEY")),
      MFP_PROXY_URL: yield* Config.option(Config.Redacted("MFP_PROXY_URL")),
    };
    const headless = yield* Config.Boolean("MFP_BROWSER_HEADLESS").pipe(Config.withDefault(true));

    const env: Record<string, string | Redacted.Redacted<string>> = {
      PORT: String(CONTAINER_PORT),
      MFP_BROWSER_HEADLESS: String(headless),
    };
    for (const [name, value] of Object.entries(secrets)) {
      if (Option.isSome(value)) env[name] = value.value;
    }

    return {
      context: "./container",
      instanceType: "standard-1",
      maxInstances: 2,
      observability: { logs: { enabled: true } },
      env,
    };
  }),
) {}
