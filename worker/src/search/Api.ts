import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { BadRequest, UpstreamFailure } from "../api/Errors.ts";
import { FoodSearchResult, SearchSource } from "./FoodSearch.ts";

// Search is public, as in backend/.

// A barcode MFP doesn't know. The 404 body mirrors the success shape.
export class BarcodeNotFound extends Schema.TaggedError<BarcodeNotFound>()(
  "BarcodeNotFound",
  {
    barcode: Schema.String,
    provider: Schema.Literal("mfp"),
    cached: Schema.Boolean,
    foods: Schema.Array(FoodSearchResult),
  },
  { httpApiStatus: 404 },
) {}

// backend/'s barcode errors carry only `error` (no `message`).
export class BarcodeLookupFailed extends Schema.TaggedError<BarcodeLookupFailed>()(
  "BarcodeLookupFailed",
  { error: Schema.String },
  { httpApiStatus: 502 },
) {}

export class BarcodeLookupUnavailable extends Schema.TaggedError<BarcodeLookupUnavailable>()(
  "BarcodeLookupUnavailable",
  { error: Schema.String },
  { httpApiStatus: 503 },
) {}

export const SearchResponse = Schema.Struct({
  query: Schema.String,
  provider: Schema.NullOr(SearchSource),
  page: Schema.Number,
  hasMore: Schema.Boolean,
  foods: Schema.Array(FoodSearchResult),
});

export const BarcodeResponse = Schema.Struct({
  barcode: Schema.String,
  provider: Schema.Literal("mfp"),
  cached: Schema.Boolean,
  foods: Schema.Array(FoodSearchResult),
});

export const AnmatLiveSearchPayload = Schema.Struct({
  query: Schema.String,
  maxItems: Schema.optionalKey(Schema.Number),
});

export class SearchGroup extends HttpApiGroup.make("search").add(
  // Query params are parsed leniently in the handler (bad numbers fall back to
  // defaults, unknown providers mean "unified"), as backend/ did.
  HttpApiEndpoint.get("search", "/search", {
    query: {
      query: Schema.optional(Schema.String),
      maxItems: Schema.optional(Schema.String),
      page: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
    },
    success: SearchResponse,
    error: [BadRequest, UpstreamFailure],
  }),
  HttpApiEndpoint.get("barcode", "/search/barcode/:barcode", {
    params: { barcode: Schema.String },
    success: BarcodeResponse,
    error: [BadRequest, BarcodeNotFound, BarcodeLookupFailed, BarcodeLookupUnavailable],
  }),
  // Records the query so ANMAT results can be seeded later. The body is read
  // leniently in the handler (any malformed body is "query is required").
  HttpApiEndpoint.post("anmatLive", "/search/anmat-live", {
    payload: AnmatLiveSearchPayload,
    success: Schema.Struct({
      query: Schema.String,
      foods: Schema.Array(FoodSearchResult),
      queued: Schema.Literal(true),
      searchRequestId: Schema.Number,
      queuedAt: Schema.String,
    }),
    error: [BadRequest, UpstreamFailure],
  }),
) {}
