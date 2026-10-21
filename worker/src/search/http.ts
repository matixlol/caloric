import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Api } from "../api/Api.ts";
import { BadRequest, UpstreamFailure } from "../api/Errors.ts";
import { SearchSource } from "./FoodSearch.ts";
import { AnmatLiveSearchPayload, BarcodeLookupFailed, BarcodeLookupUnavailable, BarcodeNotFound } from "./Api.ts";
import { SearchService } from "./SearchService.ts";

// Cap how deep infinite scroll can page into a single source.
const SEARCH_MAX_PAGES = 10;

const parseInteger = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const clamp = (min: number, max: number, value: number) => Math.max(min, Math.min(max, value));

const parseSearchSource = Schema.decodeUnknownOption(SearchSource);
const parseAnmatLiveBody = Schema.decodeUnknownOption(AnmatLiveSearchPayload);

const failWith = (code: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapCause((cause) => Effect.logError(code, cause)),
    Effect.mapError(() => UpstreamFailure.fromCode(code)),
  );

export const SearchHandlers = HttpApiBuilder.group(
  Api,
  "search",
  Effect.fn(function* (handlers) {
    const search = yield* SearchService;
    return handlers
      .handle("search", ({ query: params }) =>
        Effect.gen(function* () {
          const query = (params.query ?? "").trim();
          if (!query) {
            return yield* new BadRequest({ error: "query is required" });
          }
          const maxItems = clamp(1, 100, parseInteger(params.maxItems, 20));
          const page = clamp(1, SEARCH_MAX_PAGES, parseInteger(params.page, 1));
          const provider = parseSearchSource(params.provider);

          if (Option.isSome(provider)) {
            const result = yield* search
              .searchBySource(provider.value, query, maxItems, page)
              .pipe(failWith("search_failed"));
            return { query, provider: provider.value, page, hasMore: result.hasMore, foods: result.foods };
          }
          const foods = yield* search.searchUnified(query, maxItems).pipe(failWith("search_failed"));
          return { query, provider: null, page: 1, hasMore: false, foods };
        }),
      )
      .handle("barcode", ({ params }) =>
        Effect.gen(function* () {
          const barcode = params.barcode.trim();
          if (!/^\d{8}$|^\d{13}$/.test(barcode)) {
            return yield* new BadRequest({ error: "Barcode must be an EAN-8 or EAN-13 value." });
          }
          const result = yield* search.lookupBarcode(barcode).pipe(
            Effect.tapCause((cause) => Effect.logError("mfp.barcode.failed", cause)),
            Effect.mapError((error) =>
              error._tag === "MfpBarcodeNotConfigured"
                ? new BarcodeLookupUnavailable({ error: "Barcode lookup is not configured." })
                : new BarcodeLookupFailed({ error: "Barcode lookup failed." }),
            ),
          );
          switch (result._tag) {
            case "Found":
              return { barcode, provider: "mfp" as const, cached: result.cached, foods: result.foods };
            case "NoMatches":
              return yield* new BarcodeNotFound({ barcode, provider: "mfp", cached: result.cached, foods: [] });
            case "Rejected":
              return yield* new BadRequest({ error: "MFP rejected the barcode." });
            case "UpstreamFailed":
              return yield* new BarcodeLookupFailed({ error: "MFP barcode lookup failed." });
          }
        }),
      )
      .handleRaw("anmatLive", ({ request }) =>
        Effect.gen(function* () {
          const body = yield* request.json.pipe(Effect.option);
          const query = Option.flatMap(body, parseAnmatLiveBody).pipe(
            Option.map((payload) => payload.query.trim()),
            Option.getOrElse(() => ""),
          );
          if (query.length < 2) {
            return yield* new BadRequest({ error: "query is required" });
          }
          const queued = yield* search.enqueueAnmatLiveSearch(query).pipe(failWith("anmat_live_search_failed"));
          return {
            query,
            foods: [],
            queued: true as const,
            searchRequestId: queued.id,
            queuedAt: queued.createdAt.toISOString(),
          };
        }),
      );
  }),
).pipe(Layer.provide(SearchService.layer));
