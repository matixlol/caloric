import * as Schema from "effect/Schema";

// Effect Schema mirrors of @caloric/data-model (the zod contracts the clients
// share). Keep the two in step when the diary model changes.

const NonEmpty = Schema.NonEmptyString;
const Positive = Schema.Finite.check(Schema.isGreaterThan(0));
export const TimestampMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Meal = Schema.Literals(["breakfast", "lunch", "dinner", "snacks"]);

export const Nutrition = Schema.Struct({
  calories: Schema.optionalKey(Schema.Finite),
  protein: Schema.optionalKey(Schema.Finite),
  carbs: Schema.optionalKey(Schema.Finite),
  fat: Schema.optionalKey(Schema.Finite),
  fiber: Schema.optionalKey(Schema.Finite),
  sugars: Schema.optionalKey(Schema.Finite),
  sodiumMg: Schema.optionalKey(Schema.Finite),
  potassiumMg: Schema.optionalKey(Schema.Finite),
});

export const RecipeItem = Schema.Struct({
  id: NonEmpty,
  foodName: NonEmpty,
  brand: Schema.optionalKey(NonEmpty),
  serving: Schema.optionalKey(NonEmpty),
  portion: Positive,
  nutrition: Schema.optionalKey(Nutrition),
});

export const Recipe = Schema.Struct({
  name: NonEmpty,
  items: Schema.Array(RecipeItem),
  createdAt: TimestampMs,
});
export type Recipe = typeof Recipe.Type;

export const FoodEntry = Schema.Struct({
  meal: Meal,
  foodName: NonEmpty,
  brand: Schema.optionalKey(NonEmpty),
  serving: Schema.optionalKey(NonEmpty),
  portion: Positive,
  nutrition: Schema.optionalKey(Nutrition),
  recipeId: Schema.optionalKey(NonEmpty),
  recipeItems: Schema.optionalKey(Schema.Array(RecipeItem)),
  createdAt: TimestampMs,
  dateKey: NonEmpty,
  sortIndex: Schema.Finite,
});
export type FoodEntry = typeof FoodEntry.Type;

const Percent = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const CalorieGoal = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10000 }));

export const UserSettings = Schema.Struct({
  calorieGoal: CalorieGoal,
  macroProteinPct: Percent,
  macroCarbsPct: Percent,
  macroFatPct: Percent,
}).check(
  Schema.makeFilter(
    (settings) =>
      settings.macroProteinPct + settings.macroCarbsPct + settings.macroFatPct === 100 ||
      "Macro percentages must add up to 100",
  ),
);
export type UserSettings = typeof UserSettings.Type;

export const USER_SETTINGS_ROW_ID = "settings";
