import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { ProviderConfig } from "../ProviderConfig.ts";
import { readUpstreamResponse, type UpstreamResponse, withoutTracePropagation } from "../http.ts";
import { MfpSession } from "./MfpSession.ts";

export const MFP_BASE_URL = "https://www.myfitnesspal.com";

const MFP_API_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.165 Safari/537.36";

export class MfpRequestError extends Schema.TaggedError<MfpRequestError>()("MfpRequestError", {
  message: Schema.String,
  url: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface MfpSearchParams {
  readonly query: string;
  readonly offset: number;
  readonly maxItems: number;
  readonly countryCode: string;
  readonly resourceType: string;
}

const MissingAuthorization = Schema.Struct({
  error: Schema.Literal("validation/3"),
  error_description: Schema.String.check(Schema.isIncluding("Missing HTTP header: Authorization")),
});
const isMissingAuthorization = Schema.is(MissingAuthorization);

// An expired session shows up as 401/403, or as a 400 complaining about the
// Authorization header when the stored session had no bearer token.
const isAuthorizationError = (response: UpstreamResponse) =>
  response.status === 401 ||
  response.status === 403 ||
  (response.status === 400 && isMissingAuthorization(response.json));

const make = Effect.gen(function* () {
  const config = yield* ProviderConfig;
  const session = yield* MfpSession;
  const client = yield* HttpClient.HttpClient;

  const fetchOnce = Effect.fn("MfpClient.fetch")(function* (url: string, forceRefresh: boolean) {
    const auth = yield* session.getAuth({ forceRefresh });
    return yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": MFP_API_USER_AGENT,
        Referer: `${MFP_BASE_URL}/food/search`,
        Cookie: auth.cookieHeader,
        ...(auth.authorization ? { Authorization: auth.authorization } : {}),
      }),
      client.execute,
      Effect.flatMap(readUpstreamResponse),
      Effect.timeout(config.requestTimeout),
      withoutTracePropagation,
      Effect.mapError((cause) => new MfpRequestError({ message: "MFP request failed", url, cause })),
    );
  });

  // GETs an MFP web API path with the stored session, refreshing it once when
  // MFP rejects it.
  const request = Effect.fn("MfpClient.request")(function* (pathWithQuery: string) {
    const url = new URL(pathWithQuery, MFP_BASE_URL).toString();
    const response = yield* fetchOnce(url, false);
    if (isAuthorizationError(response)) {
      yield* Effect.logWarning("mfp.request.auth_rejected", { url, status: response.status });
      return yield* fetchOnce(url, true);
    }
    return response;
  });

  const searchNutrition = (params: MfpSearchParams) =>
    request(
      `/api/nutrition?${new URLSearchParams({
        query: params.query,
        offset: String(params.offset),
        max_items: String(params.maxItems),
        country_code: params.countryCode,
        resource_type: params.resourceType,
      }).toString()}`,
    );

  const fetchFoodDetail = (foodId: string, version: string) =>
    request(`/api/services/foods/${encodeURIComponent(foodId)}?${new URLSearchParams({ version }).toString()}`);

  return { searchNutrition, fetchFoodDetail };
});

export class MfpClient extends Context.Service<MfpClient, Effect.Success<typeof make>>()(
  "caloric/providers/MfpClient",
) {
  static readonly layer = Layer.effect(MfpClient, make);
}
