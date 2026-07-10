import type { FoodEntry, Meal, Nutrition, Recipe, RecipeItem } from "@caloric/data-model";
import { createRecipeItemId } from "./id";
import { sanitizePortion } from "./portion";

const NUTRITION_KEYS = ["calories", "protein", "carbs", "fat", "fiber", "sugars", "sodiumMg", "potassiumMg"] as const;

export function aggregateRecipeNutrition(items: RecipeItem[]): Nutrition | undefined {
  const result: Nutrition = {};
  for (const key of NUTRITION_KEYS) {
    let defined = false;
    let total = 0;
    for (const item of items) {
      const value = item.nutrition?.[key];
      if (value !== undefined) {
        defined = true;
        total += value * sanitizePortion(item.portion);
      }
    }
    if (defined) result[key] = total;
  }
  return Object.keys(result).length ? result : undefined;
}

export function buildRecipeLogEntryInput(recipe: Recipe & { id?: string }, input: { meal: Meal; dateKey: string; portion: number }): Omit<FoodEntry, "sortIndex"> {
  return { meal: input.meal, dateKey: input.dateKey, foodName: recipe.name, serving: "1 recipe", portion: sanitizePortion(input.portion), nutrition: aggregateRecipeNutrition(recipe.items), recipeId: recipe.id, recipeItems: recipe.items.map((item) => ({ ...item })), createdAt: Date.now() };
}

export function duplicateRecipeInput(recipe: Recipe): Recipe {
  return { name: `${recipe.name} copy`, createdAt: Date.now(), items: recipe.items.map((item) => ({ ...item, id: createRecipeItemId() })) };
}
