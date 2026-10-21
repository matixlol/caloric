import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ProviderConfig } from "../ProviderConfig.ts";
import { readUpstreamResponse, withoutTracePropagation } from "../http.ts";

export class OpenFoodFactsError extends Schema.TaggedError<OpenFoodFactsError>()("OpenFoodFactsError", {
  message: Schema.String,
  url: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface OpenFoodFactsSearchParams {
  readonly query: string;
  readonly page: number;
  readonly pageSize: number;
}

const FIELDS = ["code", "product_name", "brands", "quantity", "serving_size", "nutriments"].join(",");

const make = Effect.gen(function* () {
  const config = yield* ProviderConfig;
  const client = yield* HttpClient.HttpClient;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": config.openFoodFactsUserAgent,
    ...(config.openFoodFactsUserEmail ? { From: config.openFoodFactsUserEmail } : {}),
  };

  const search = Effect.fn("OpenFoodFactsClient.search")(function* (params: OpenFoodFactsSearchParams) {
    const url = new URL("/cgi/search.pl", `${config.openFoodFactsBaseUrl}/`);
    url.searchParams.set("search_terms", params.query);
    url.searchParams.set("search_simple", "1");
    url.searchParams.set("action", "process");
    url.searchParams.set("json", "1");
    url.searchParams.set("page", String(params.page));
    url.searchParams.set("page_size", String(params.pageSize));
    url.searchParams.set("fields", FIELDS);

    return yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
      client.execute,
      Effect.flatMap(readUpstreamResponse),
      Effect.timeout(config.requestTimeout),
      withoutTracePropagation,
      Effect.mapError(
        (cause) => new OpenFoodFactsError({ message: "Open Food Facts request failed", url: url.toString(), cause }),
      ),
    );
  });

  return { search };
});

export class OpenFoodFactsClient extends Context.Service<OpenFoodFactsClient, Effect.Success<typeof make>>()(
  "caloric/providers/OpenFoodFactsClient",
) {
  static readonly layer = Layer.effect(OpenFoodFactsClient, make);
}
