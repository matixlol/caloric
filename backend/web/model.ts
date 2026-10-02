import {
  DEFAULT_USER_SETTINGS,
  FoodEntrySchema,
  RecipeSchema,
  UserSettingsSchema,
  type FoodEntry,
  type Meal,
  type Nutrition,
  type Recipe,
  type UserSettings,
} from "@caloric/data-model";
import { z } from "zod";

export const meals = ["breakfast", "lunch", "dinner", "snacks"] as const;
export const label = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);
// Matches mobile/app/log-food.tsx: 54px dead zone, quarter portions,
// and double-height whole-number targets (not a uniform linear slider).
export const portionValues = Array.from(
  { length: 12 },
  (_, index) => (index + 1) / 4,
);
const portionOffsets = portionValues.reduce<number[]>(
  (offsets, value, index) => {
    if (!index) return [0];
    const previousWeight = Number.isInteger(portionValues[index - 1]) ? 2 : 1;
    const weight = Number.isInteger(value) ? 2 : 1;
    offsets.push(offsets[index - 1] + (25 * (previousWeight + weight)) / 2);
    return offsets;
  },
  [],
);
export function portionFromDrag(deltaY: number) {
  const distance = -deltaY - 54;
  if (distance < 0) return null;
  let nearest = 0;
  for (let index = 1; index < portionOffsets.length; index++) {
    if (
      Math.abs(distance - portionOffsets[index]) <
      Math.abs(distance - portionOffsets[nearest])
    )
      nearest = index;
  }
  return portionValues[nearest];
}
export type Entry = { id: string; data: FoodEntry; updatedAt: number };
export type SavedRecipe = { id: string; data: Recipe; updatedAt: number };
export type Snapshot = {
  entries: Entry[];
  recipes: SavedRecipe[];
  settings: UserSettings;
};
export type Food = {
  id: string;
  name: string;
  brand?: string;
  serving?: string;
  nutrition?: Nutrition;
  sourceLabel?: string;
};
const row = {
  id: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
};
export const SnapshotSchema = z.object({
  entries: z.array(z.object({ ...row, data: FoodEntrySchema })),
  recipes: z.array(z.object({ ...row, data: RecipeSchema })),
  settings: UserSettingsSchema,
});
const BootstrapSchema = z.object({
  foodEntries: z.array(z.object({ ...row, data: FoodEntrySchema })),
  recipes: z.array(z.object({ ...row, data: RecipeSchema })),
  settings: z.object({ ...row, data: UserSettingsSchema }).nullable(),
});

// Local calendar dates, not UTC, so the journal does not jump days at midnight.
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function shiftDate(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  return dateKey(new Date(year, month - 1, day + days, 12));
}
export function calendarDate(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}
export function totals(
  entries: Pick<FoodEntry, "nutrition" | "portion">[],
): Nutrition {
  const result: Nutrition = {};
  for (const entry of entries) {
    for (const key of Object.keys(
      entry.nutrition || {},
    ) as (keyof Nutrition)[]) {
      const value = entry.nutrition?.[key];
      if (value !== undefined)
        result[key] = (result[key] || 0) + value * entry.portion;
    }
  }
  return result;
}
export function macroGoals(settings: UserSettings) {
  return {
    protein: Math.round(
      (settings.calorieGoal * settings.macroProteinPct) / 100 / 4,
    ),
    carbs: Math.round(
      (settings.calorieGoal * settings.macroCarbsPct) / 100 / 4,
    ),
    fat: Math.round((settings.calorieGoal * settings.macroFatPct) / 100 / 9),
  };
}
export function orderedDay(snapshot: Snapshot, key: string) {
  return snapshot.entries
    .filter((row) => row.data.dateKey === key)
    .sort(
      (a, b) =>
        a.data.sortIndex - b.data.sortIndex ||
        a.data.createdAt - b.data.createdAt,
    );
}
// The destination index is measured AFTER removing the moving entry.
// Touch and keyboard sorting share this persisted order.
export function reorderEntries(
  entries: Entry[],
  id: string,
  meal: Meal,
  index: number,
): Entry[] {
  const moving = entries.find((row) => row.id === id);
  if (!moving) return [];
  const others = entries.filter((row) => row.id !== id);
  const destination = others.filter((row) => row.data.meal === meal);
  const position = Math.max(0, Math.min(destination.length, index));
  if (
    moving.data.meal === meal &&
    entries
      .filter((row) => row.data.meal === meal)
      .findIndex((row) => row.id === id) === position
  )
    return [];
  destination.splice(position, 0, {
    ...moving,
    data: { ...moving.data, meal },
  });
  const now = Date.now();
  return meals
    .flatMap((key) =>
      key === meal
        ? destination
        : others.filter((row) => row.data.meal === key),
    )
    .map((row, sortIndex) => ({
      ...row,
      data: { ...row.data, sortIndex },
      updatedAt: now,
    }))
    .filter((row) => {
      const original = entries.find((entry) => entry.id === row.id)!;
      return (
        original.data.sortIndex !== row.data.sortIndex ||
        original.data.meal !== row.data.meal
      );
    });
}
export function makeEntry(
  food: Food,
  meal: Meal,
  key: string,
  portion: number,
  snapshot: Snapshot,
): Entry {
  const now = Date.now();
  return {
    id: `food_${crypto.randomUUID()}`,
    updatedAt: now,
    data: FoodEntrySchema.parse({
      foodName: food.name,
      brand: food.brand,
      serving: food.serving,
      nutrition: food.nutrition,
      meal,
      dateKey: key,
      portion,
      createdAt: now,
      sortIndex:
        Math.max(
          -1,
          ...orderedDay(snapshot, key).map((row) => row.data.sortIndex),
        ) + 1,
    }),
  };
}
export function recipeFood(recipe: SavedRecipe): Food {
  return {
    id: recipe.id,
    name: recipe.data.name,
    serving: "1 recipe",
    nutrition: totals(recipe.data.items),
    sourceLabel: "Recipe",
  };
}

export const catalogue: Food[] = [
  {
    id: "yogurt",
    name: "Greek yogurt",
    brand: "Fage · 2%",
    serving: "170 g",
    nutrition: { calories: 120, protein: 17, carbs: 5, fat: 4 },
  },
  {
    id: "blueberries",
    name: "Blueberries",
    serving: "100 g",
    nutrition: {
      calories: 57,
      protein: 0.7,
      carbs: 14.5,
      fat: 0.3,
      fiber: 2.4,
    },
  },
  {
    id: "granola",
    name: "Honey & oat granola",
    serving: "40 g",
    nutrition: { calories: 180, protein: 4, carbs: 28, fat: 6, fiber: 3 },
  },
  {
    id: "coffee",
    name: "Flat white",
    serving: "180 ml",
    nutrition: { calories: 90, protein: 5, carbs: 7, fat: 4 },
  },
  {
    id: "chicken",
    name: "Grilled chicken breast",
    serving: "150 g",
    nutrition: { calories: 248, protein: 46.5, carbs: 0, fat: 5.4 },
  },
  {
    id: "rice",
    name: "Brown rice, cooked",
    serving: "150 g",
    nutrition: { calories: 185, protein: 4, carbs: 38, fat: 1.5, fiber: 2.7 },
  },
  {
    id: "avocado",
    name: "Avocado",
    serving: "½ medium · 75 g",
    nutrition: { calories: 120, protein: 1.5, carbs: 6.4, fat: 11, fiber: 5 },
  },
  {
    id: "broccoli",
    name: "Broccoli, steamed",
    serving: "100 g",
    nutrition: { calories: 35, protein: 2.4, carbs: 7, fat: 0.4, fiber: 3.3 },
  },
  {
    id: "banana",
    name: "Banana",
    serving: "1 medium · 118 g",
    nutrition: { calories: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1 },
  },
  {
    id: "almonds",
    name: "Almonds",
    serving: "20 g",
    nutrition: { calories: 116, protein: 4.2, carbs: 4.3, fat: 10, fiber: 2.5 },
  },
  {
    id: "salmon",
    name: "Baked salmon",
    serving: "150 g",
    nutrition: { calories: 309, protein: 33, carbs: 0, fat: 18.5 },
  },
  {
    id: "potato",
    name: "Roasted sweet potato",
    serving: "200 g",
    nutrition: { calories: 180, protein: 4, carbs: 41, fat: 0.3, fiber: 6 },
  },
  {
    id: "eggs",
    name: "Scrambled eggs",
    serving: "2 large eggs",
    nutrition: { calories: 182, protein: 12, carbs: 2, fat: 14 },
  },
  {
    id: "toast",
    name: "Sourdough toast",
    serving: "1 slice · 50 g",
    nutrition: { calories: 130, protein: 4, carbs: 25, fat: 1 },
  },
  {
    id: "apple",
    name: "Apple",
    serving: "1 medium",
    nutrition: { calories: 95, protein: 0.5, carbs: 25, fat: 0.3, fiber: 4.4 },
  },
  {
    id: "oats",
    name: "Rolled oats",
    serving: "40 g dry",
    nutrition: { calories: 150, protein: 5, carbs: 27, fat: 3, fiber: 4 },
  },
  {
    id: "milk",
    name: "Oat milk",
    brand: "Oatly",
    serving: "200 ml",
    nutrition: { calories: 92, protein: 2, carbs: 13.4, fat: 3 },
  },
  {
    id: "pasta",
    name: "Whole wheat pasta",
    serving: "180 g cooked",
    nutrition: { calories: 268, protein: 10, carbs: 54, fat: 2, fiber: 7 },
  },
  {
    id: "tuna",
    name: "Tuna in spring water",
    serving: "120 g drained",
    nutrition: { calories: 139, protein: 31, carbs: 0, fat: 1 },
  },
  {
    id: "chocolate",
    name: "Dark chocolate",
    brand: "Lindt · 70%",
    serving: "20 g",
    nutrition: { calories: 113, protein: 1.6, carbs: 6.6, fat: 8.2 },
  },
];

export function createDemo(today = dateKey()): Snapshot {
  const snapshot: Snapshot = {
    entries: [],
    recipes: [],
    settings: {
      calorieGoal: 2200,
      macroProteinPct: 30,
      macroCarbsPct: 45,
      macroFatPct: 25,
    },
  };
  const mealFoods: [Meal, string[]][] = [
    ["breakfast", ["yogurt", "blueberries", "granola", "coffee"]],
    ["lunch", ["chicken", "rice", "avocado", "broccoli"]],
    ["snacks", ["banana", "almonds"]],
    ["dinner", ["salmon", "potato"]],
  ];
  for (let offset = -6; offset <= 0; offset++) {
    for (const [meal, ids] of mealFoods) {
      if (offset === 0 && meal === "dinner") continue;
      ids.forEach((id, index) => {
        const food = catalogue.find((food) => food.id === id)!;
        snapshot.entries.push({
          id: `demo_${offset}_${id}`,
          updatedAt: calendarDate(shiftDate(today, offset)).getTime(),
          data: {
            foodName: food.name,
            brand: food.brand,
            serving: food.serving,
            nutrition: food.nutrition,
            portion: offset === -2 && id === "rice" ? 1.5 : 1,
            meal,
            dateKey: shiftDate(today, offset),
            createdAt: calendarDate(shiftDate(today, offset)).getTime(),
            sortIndex: meals.indexOf(meal) * 100 + index,
          },
        });
      });
    }
  }
  for (const [name, ids] of [
    ["My breakfast bowl", ["yogurt", "blueberries", "granola"]],
    ["Chicken & rice bowl", ["chicken", "rice", "avocado", "broccoli"]],
    ["Salmon supper", ["salmon", "potato"]],
  ] as const) {
    snapshot.recipes.push({
      id: `demo_recipe_${snapshot.recipes.length}`,
      updatedAt: Date.now(),
      data: {
        name,
        createdAt: Date.now(),
        items: ids.map((id) => {
          const food = catalogue.find((food) => food.id === id)!;
          return {
            id,
            foodName: food.name,
            brand: food.brand,
            serving: food.serving,
            portion: 1,
            nutrition: food.nutrition,
          };
        }),
      },
    });
  }
  return SnapshotSchema.parse(snapshot);
}

export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const payload = await response.json();
  if (!response.ok)
    throw new Error(
      payload.message ||
        payload.error ||
        `Request failed (${response.status}).`,
    );
  return payload as T;
}
export async function bootstrap(): Promise<Snapshot> {
  const result = BootstrapSchema.parse(await api("/sync/bootstrap"));
  return {
    entries: result.foodEntries,
    recipes: result.recipes,
    settings: result.settings?.data || { ...DEFAULT_USER_SETTINGS },
  };
}
export type Changes = {
  entries?: (Entry & { deletedAt?: number })[];
  recipes?: (SavedRecipe & { deletedAt?: number })[];
  settings?: UserSettings;
};
export async function pushChanges(changes: Changes) {
  const result = await api<{
    acceptedFoodEntryIds: string[];
    acceptedRecipeIds: string[];
    acceptedSettings: boolean;
  }>("/sync/push", {
    foodEntries: changes.entries || [],
    recipes: changes.recipes || [],
    settings: changes.settings
      ? { id: "settings", data: changes.settings, updatedAt: Date.now() }
      : undefined,
  });
  if (
    changes.entries?.some(
      (row) => !result.acceptedFoodEntryIds.includes(row.id),
    ) ||
    changes.recipes?.some(
      (row) => !result.acceptedRecipeIds.includes(row.id),
    ) ||
    (changes.settings && !result.acceptedSettings)
  ) {
    throw new Error(
      "A newer change was saved elsewhere. Refresh your journal before trying again.",
    );
  }
}
export function applyChanges(snapshot: Snapshot, changes: Changes): Snapshot {
  function merge<T extends { id: string }>(
    rows: T[],
    updates: (T & { deletedAt?: number })[] = [],
  ): T[] {
    const ids = new Set(updates.map((row) => row.id));
    return [
      ...rows.filter((row) => !ids.has(row.id)),
      ...updates.filter((row) => row.deletedAt === undefined),
    ];
  }
  return SnapshotSchema.parse({
    entries: merge(snapshot.entries, changes.entries),
    recipes: merge(snapshot.recipes, changes.recipes),
    settings: changes.settings || snapshot.settings,
  });
}
