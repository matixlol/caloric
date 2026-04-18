import { z } from "zod";

export const MealSchema = z.enum(["breakfast", "lunch", "dinner", "snacks"]);
export type Meal = z.infer<typeof MealSchema>;

export const NutritionSchema = z
  .object({
    calories: z.number().optional(),
    protein: z.number().optional(),
    carbs: z.number().optional(),
    fat: z.number().optional(),
    fiber: z.number().optional(),
    sugars: z.number().optional(),
    sodiumMg: z.number().optional(),
    potassiumMg: z.number().optional(),
  })
  .strict();
export type Nutrition = z.infer<typeof NutritionSchema>;

export const FoodEntrySchema = z
  .object({
    meal: MealSchema,
    foodName: z.string().min(1),
    brand: z.string().min(1).optional(),
    serving: z.string().min(1).optional(),
    portion: z.number().positive(),
    nutrition: NutritionSchema.optional(),
    createdAt: z.number().int().nonnegative(),
    dateKey: z.string().min(1),
    sortIndex: z.number(),
  })
  .strict();
export type FoodEntry = z.infer<typeof FoodEntrySchema>;

export const UserSettingsSchema = z
  .object({
    calorieGoal: z.number().int().min(100).max(10000),
    macroProteinPct: z.number().int().min(0).max(100),
    macroCarbsPct: z.number().int().min(0).max(100),
    macroFatPct: z.number().int().min(0).max(100),
  })
  .strict()
  .refine(
    (value) => value.macroProteinPct + value.macroCarbsPct + value.macroFatPct === 100,
    "Macro percentages must add up to 100",
  );
export type UserSettings = z.infer<typeof UserSettingsSchema>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  calorieGoal: 2500,
  macroProteinPct: 30,
  macroCarbsPct: 50,
  macroFatPct: 20,
};

export const USER_SETTINGS_ROW_ID = "settings";
