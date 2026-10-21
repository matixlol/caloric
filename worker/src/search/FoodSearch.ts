import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Contract between food search (implemented in src/search) and its consumers
// (the search endpoint and the AI assistant's search tool).

export const SearchSource = Schema.Literals(["mfp", "anmat", "openfoodfacts"]);
export type SearchSource = typeof SearchSource.Type;

export const FoodNutrition = Schema.Struct({
  calories: Schema.optionalKey(Schema.Finite),
  protein: Schema.optionalKey(Schema.Finite),
  carbs: Schema.optionalKey(Schema.Finite),
  fat: Schema.optionalKey(Schema.Finite),
  fiber: Schema.optionalKey(Schema.Finite),
  sugars: Schema.optionalKey(Schema.Finite),
  sodiumMg: Schema.optionalKey(Schema.Finite),
  potassiumMg: Schema.optionalKey(Schema.Finite),
});
export type FoodNutrition = typeof FoodNutrition.Type;

export const FoodSearchResult = Schema.Struct({
  id: Schema.String,
  canonicalKey: Schema.String,
  source: SearchSource,
  sourceLabel: Schema.Literals(["MFP", "ANMAT", "OFF"]),
  name: Schema.String,
  brand: Schema.optionalKey(Schema.String),
  serving: Schema.optionalKey(Schema.String),
  nutrition: Schema.optionalKey(FoodNutrition),
});
export type FoodSearchResult = typeof FoodSearchResult.Type;

export class FoodSearchError extends Schema.TaggedError<FoodSearchError>()("FoodSearchError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class FoodSearch extends Context.Service<
  FoodSearch,
  {
    // Ranked results across sources (MFP first, then Open Food Facts/ANMAT),
    // as backend/'s `searchUnifiedFoods(query, limit)`.
    readonly searchUnified: (
      query: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<FoodSearchResult>, FoodSearchError>;
  }
>()("caloric/search/FoodSearch") {}
