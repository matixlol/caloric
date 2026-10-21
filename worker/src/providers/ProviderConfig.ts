import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

const make = Effect.gen(function* () {
  const searchCacheTtlDays = yield* Config.Number("SEARCH_CACHE_TTL_DAYS").pipe(Config.withDefault(30));
  const detailConcurrency = yield* Config.Number("MFP_DETAIL_CONCURRENCY").pipe(Config.withDefault(10));
  const requestTimeoutMs = yield* Config.Number("MFP_REQUEST_TIMEOUT_MS").pipe(Config.withDefault(20_000));
  const mfpGuestAccessToken: Option.Option<Redacted.Redacted<string>> = yield* Config.Redacted(
    "MFP_GUEST_ACCESS_TOKEN",
  ).pipe(Config.option);
  const openFoodFactsBaseUrl = yield* Config.String("OPEN_FOOD_FACTS_BASE_URL").pipe(
    Config.withDefault("https://world.openfoodfacts.net"),
  );
  const openFoodFactsUserAgent = yield* Config.String("OPEN_FOOD_FACTS_USER_AGENT").pipe(
    Config.withDefault("Caloric/1.0 (OpenFoodFacts integration; contact required)"),
  );
  const openFoodFactsUserEmail = yield* Config.String("OPEN_FOOD_FACTS_USER_EMAIL").pipe(Config.withDefault(""));

  return {
    searchCacheTtl: Duration.days(Math.max(1, searchCacheTtlDays)),
    detailConcurrency: Math.max(1, Math.floor(detailConcurrency)),
    requestTimeout: Duration.millis(Math.max(1000, requestTimeoutMs)),
    mfpGuestAccessToken,
    openFoodFactsBaseUrl: openFoodFactsBaseUrl.replace(/\/+$/, ""),
    openFoodFactsUserAgent,
    openFoodFactsUserEmail: openFoodFactsUserEmail.trim(),
  };
});

// Settings for the food data providers (backend/'s config.ts equivalents).
// Read once at layer construction so Alchemy binds them onto the Worker.
export class ProviderConfig extends Context.Service<ProviderConfig, Effect.Success<typeof make>>()(
  "caloric/providers/ProviderConfig",
) {
  static readonly layer = Layer.effect(ProviderConfig, make);
}
