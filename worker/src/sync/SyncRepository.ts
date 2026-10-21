import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SyncFoodEntryRow, SyncRecipeRow, SyncSettingsRow } from "./Api.ts";
import { Db, withRuntime } from "../db/Db.ts";
import { userFoodEntries, userRecipes, userSettings } from "../db/schema.ts";
import { USER_SETTINGS_ROW_ID } from "../domain/Diary.ts";

type FoodEntryRow = typeof SyncFoodEntryRow.Type;
type RecipeRow = typeof SyncRecipeRow.Type;
type SettingsRow = typeof SyncSettingsRow.Type;

const toDate = (millis: number | null | undefined) => (typeof millis === "number" ? new Date(millis) : null);

const make = Effect.gen(function* () {
  const db = yield* Db;

  const bootstrap = Effect.fn("SyncRepository.bootstrap")(function* (userId: string) {
    const [foodEntries, recipes, settings] = yield* Effect.all(
      [
        db
          .select({ id: userFoodEntries.id, data: userFoodEntries.data, updatedAt: userFoodEntries.updatedAt })
          .from(userFoodEntries)
          .where(and(eq(userFoodEntries.userId, userId), isNull(userFoodEntries.deletedAt)))
          .orderBy(asc(userFoodEntries.updatedAt), asc(userFoodEntries.id)),
        db
          .select({ id: userRecipes.id, data: userRecipes.data, updatedAt: userRecipes.updatedAt })
          .from(userRecipes)
          .where(and(eq(userRecipes.userId, userId), isNull(userRecipes.deletedAt)))
          .orderBy(asc(userRecipes.updatedAt), asc(userRecipes.id)),
        db
          .select({ data: userSettings.data, updatedAt: userSettings.updatedAt })
          .from(userSettings)
          .where(eq(userSettings.userId, userId))
          .limit(1),
      ],
      { concurrency: "unbounded" },
    );

    return {
      foodEntries: foodEntries.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() })),
      recipes: recipes.map((row) => ({ ...row, updatedAt: row.updatedAt.getTime() })),
      settings: settings[0]
        ? { id: USER_SETTINGS_ROW_ID, data: settings[0].data, updatedAt: settings[0].updatedAt.getTime() }
        : null,
    };
  }, withRuntime);

  // Last-writer-wins upserts: a write applies when it is at least as new as
  // the stored row. RETURNING yields a row only when the write applied.
  const pushFoodEntry = (userId: string, row: FoodEntryRow) => {
    const values = { data: row.data, updatedAt: new Date(row.updatedAt), deletedAt: toDate(row.deletedAt) };
    return db
      .insert(userFoodEntries)
      .values({ userId, id: row.id, ...values })
      .onConflictDoUpdate({
        target: [userFoodEntries.userId, userFoodEntries.id],
        set: values,
        setWhere: lte(userFoodEntries.updatedAt, sql`excluded.updated_at`),
      })
      .returning({ id: userFoodEntries.id })
      .pipe(Effect.map((rows) => rows.length > 0));
  };

  const pushRecipe = (userId: string, row: RecipeRow) => {
    const values = { data: row.data, updatedAt: new Date(row.updatedAt), deletedAt: toDate(row.deletedAt) };
    return db
      .insert(userRecipes)
      .values({ userId, id: row.id, ...values })
      .onConflictDoUpdate({
        target: [userRecipes.userId, userRecipes.id],
        set: values,
        setWhere: lte(userRecipes.updatedAt, sql`excluded.updated_at`),
      })
      .returning({ id: userRecipes.id })
      .pipe(Effect.map((rows) => rows.length > 0));
  };

  const pushSettings = (userId: string, row: SettingsRow) => {
    const values = { data: row.data, updatedAt: new Date(row.updatedAt) };
    return db
      .insert(userSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: values,
        setWhere: lte(userSettings.updatedAt, sql`excluded.updated_at`),
      })
      .returning({ userId: userSettings.userId })
      .pipe(Effect.map((rows) => rows.length > 0));
  };

  const acceptedIds = <R extends { readonly id: string }, E>(
    rows: ReadonlyArray<R>,
    write: (row: R) => Effect.Effect<boolean, E>,
  ) =>
    Effect.forEach(rows, (row) => write(row).pipe(Effect.map((accepted) => (accepted ? [row.id] : []))), {
      concurrency: 1,
    }).pipe(Effect.map((ids) => ids.flat()));

  const push = Effect.fn("SyncRepository.push")(function* (
    userId: string,
    body: {
      readonly foodEntries: ReadonlyArray<FoodEntryRow>;
      readonly recipes: ReadonlyArray<RecipeRow>;
      readonly settings?: SettingsRow | null;
    },
  ) {
    const acceptedFoodEntryIds = yield* acceptedIds(body.foodEntries, (row) => pushFoodEntry(userId, row));
    const acceptedRecipeIds = yield* acceptedIds(body.recipes, (row) => pushRecipe(userId, row));
    const acceptedSettings = body.settings ? yield* pushSettings(userId, body.settings) : false;
    return { acceptedFoodEntryIds, acceptedRecipeIds, acceptedSettings };
  }, withRuntime);

  return { bootstrap, push };
});

export class SyncRepository extends Context.Service<SyncRepository, Effect.Success<typeof make>>()(
  "caloric/sync/SyncRepository",
) {
  static readonly layer = Layer.effect(SyncRepository, make);
}
