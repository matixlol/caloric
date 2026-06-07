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

const NonEmptyString = z.string().min(1);
const TimestampMs = z.number().int().nonnegative();
const SocialProfileShape = { userId: NonEmptyString, displayName: NonEmptyString };
const SocialRequestShape = { id: NonEmptyString, createdAt: TimestampMs };

export const SocialProfileSchema = z
  .object(SocialProfileShape)
  .strict();
export type SocialProfile = z.infer<typeof SocialProfileSchema>;

export const SocialOverviewSchema = z
  .object({
    profile: SocialProfileSchema.extend({
      friendCode: NonEmptyString,
    }),
    friends: z.array(
      SocialProfileSchema.extend({
        since: TimestampMs,
      }),
    ),
    incomingRequests: z.array(
      z
        .object({
          ...SocialRequestShape,
          requester: SocialProfileSchema,
        })
        .strict(),
    ),
    outgoingRequests: z.array(
      z
        .object({
          ...SocialRequestShape,
          recipient: SocialProfileSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type SocialOverview = z.infer<typeof SocialOverviewSchema>;

export const FriendDailySummarySchema = z
  .object({
    ...SocialProfileShape,
    dateKey: NonEmptyString,
    calories: z.number(),
    protein: z.number(),
    carbs: z.number(),
    fat: z.number(),
    calorieGoal: z.number().int().min(100).max(10000).nullable(),
    lastUpdatedAt: TimestampMs.nullable(),
  })
  .strict();
export type FriendDailySummary = z.infer<typeof FriendDailySummarySchema>;

export const FriendDailySummariesResponseSchema = z
  .object({
    summaries: z.array(FriendDailySummarySchema).default([]),
  })
  .strict();
export type FriendDailySummariesResponse = z.infer<typeof FriendDailySummariesResponseSchema>;
