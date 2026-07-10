import { FoodEntrySchema, RecipeSchema, USER_SETTINGS_ROW_ID, UserSettingsSchema } from "@caloric/data-model";
import { z } from "zod";

export const SyncFoodEntryRowSchema = z
  .object({
    id: z.string().min(1),
    data: FoodEntrySchema,
    updatedAt: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const SyncUserSettingsRowSchema = z
  .object({
    id: z.literal(USER_SETTINGS_ROW_ID),
    data: UserSettingsSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export const SyncRecipeRowSchema = z.object({ id: z.string().min(1), data: RecipeSchema, updatedAt: z.number().int().nonnegative(), deletedAt: z.number().int().nonnegative().nullable().optional() }).strict();

export const SyncPushBodySchema = z
  .object({
    foodEntries: z.array(SyncFoodEntryRowSchema).default([]),
    recipes: z.array(SyncRecipeRowSchema).default([]),
    settings: SyncUserSettingsRowSchema.nullish(),
  })
  .strict();

export type SyncFoodEntryRow = z.infer<typeof SyncFoodEntryRowSchema>;
export type SyncUserSettingsRow = z.infer<typeof SyncUserSettingsRowSchema>;
export type SyncPushBody = z.infer<typeof SyncPushBodySchema>;

export function parseSyncPushBody(value: unknown): SyncPushBody {
  return SyncPushBodySchema.parse(value);
}

export function shouldApplyIncomingWrite(
  existingUpdatedAt: Date | number | null | undefined,
  incomingUpdatedAt: number,
): boolean {
  if (existingUpdatedAt === null || typeof existingUpdatedAt === "undefined") {
    return true;
  }

  const existingTime =
    existingUpdatedAt instanceof Date ? existingUpdatedAt.getTime() : existingUpdatedAt;

  return incomingUpdatedAt >= existingTime;
}
