import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FoodSearch, FoodSearchError } from "./FoodSearch.ts";
import { SearchService } from "./SearchService.ts";

// The `FoodSearch` contract for the AI assistant's search tool. Requires `Db`,
// `HttpClient`, `MfpLogin` and the provider Config keys.
export const FoodSearchLive = Layer.effect(
  FoodSearch,
  Effect.gen(function* () {
    const search = yield* SearchService;
    return FoodSearch.of({
      searchUnified: (query, limit) =>
        search.searchUnified(query, limit).pipe(
          Effect.mapError((cause) => new FoodSearchError({ message: "Food search failed", cause })),
        ),
    });
  }),
).pipe(Layer.provide(SearchService.layer));
