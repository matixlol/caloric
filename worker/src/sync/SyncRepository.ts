import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SyncFoodEntryRow, SyncRecipeRow, SyncSettingsRow } from "./Api.ts";
import { type BatchDb, type Batch, Db, DbBatch, withRuntime } from "../db/Db.ts";
import { userFoodEntries, userRecipes, userSettings } from "../db/schema.ts";
import { USER_SETTINGS_ROW_ID } from "../domain/Diary.ts";

type FoodEntryRow = typeof SyncFoodEntryRow.Type;
type RecipeRow = typeof SyncRecipeRow.Type;
type SettingsRow = typeof SyncSettingsRow.Type;

const toDate = (millis: number | null | undefined) => (typeof millis === "number" ? new Date(millis) : null);

const make = Effect.gen(function* () {
  const db = yield* Db;
  const batch = yield* DbBatch;

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
  // the stored row, and RETURNING yields only the rows that applied. Rows go
  // in multi-row statements (D1 allows 100 bound parameters per statement);
  // each row binds 5 parameters. A push is one D1 batch: one round trip, and
  // it applies entirely or not at all.
  const ROWS_PER_STATEMENT = 19;

  // A statement can't upsert the same key twice, so a push that repeats an id
  // keeps only its newest copy (what sequential last-writer-wins would leave).
  const newestById = <R extends { readonly id: string; readonly updatedAt: number }>(rows: ReadonlyArray<R>) => {
    const newest = new Map<string, R>();
    for (const row of rows) {
      const current = newest.get(row.id);
      if (!current || row.updatedAt >= current.updatedAt) newest.set(row.id, row);
    }
    return [...newest.values()];
  };

  const chunks = <A>(items: ReadonlyArray<A>) =>
    Array.from({ length: Math.ceil(items.length / ROWS_PER_STATEMENT) }, (_, index) =>
      items.slice(index * ROWS_PER_STATEMENT, (index + 1) * ROWS_PER_STATEMENT),
    );

  const upsertRows = (
    q: BatchDb,
    table: typeof userFoodEntries | typeof userRecipes,
    userId: string,
    rows: ReadonlyArray<FoodEntryRow | RecipeRow>,
  ) =>
    q
      .insert(table)
      .values(
        rows.map((row) => ({
          userId,
          id: row.id,
          data: row.data as never,
          updatedAt: new Date(row.updatedAt),
          deletedAt: toDate(row.deletedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [table.userId, table.id],
        set: {
          data: sql`excluded.data`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
        setWhere: lte(table.updatedAt, sql`excluded.updated_at`),
      })
      .returning({ id: table.id });

  const upsertSettings = (q: BatchDb, userId: string, row: SettingsRow) => {
    const values = { data: row.data, updatedAt: new Date(row.updatedAt) };
    return q
      .insert(userSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: values,
        setWhere: lte(userSettings.updatedAt, sql`excluded.updated_at`),
      })
      .returning({ userId: userSettings.userId });
  };

  const push = Effect.fn("SyncRepository.push")(function* (
    userId: string,
    body: {
      readonly foodEntries: ReadonlyArray<FoodEntryRow>;
      readonly recipes: ReadonlyArray<RecipeRow>;
      readonly settings?: SettingsRow | null;
    },
  ) {
    const foodEntryChunks = chunks(newestById(body.foodEntries));
    const recipeChunks = chunks(newestById(body.recipes));
    const settings = body.settings ?? undefined;
    if (foodEntryChunks.length + recipeChunks.length === 0 && !settings) {
      return { acceptedFoodEntryIds: [], acceptedRecipeIds: [], acceptedSettings: false };
    }

    const results = (yield* batch.run(
      (q) =>
        [
          ...foodEntryChunks.map((rows) => upsertRows(q, userFoodEntries, userId, rows)),
          ...recipeChunks.map((rows) => upsertRows(q, userRecipes, userId, rows)),
          ...(settings ? [upsertSettings(q, userId, settings)] : []),
        ] as unknown as Batch,
    )) as unknown as ReadonlyArray<ReadonlyArray<{ readonly id?: string }>>;

    const ids = (from: number, count: number) =>
      results.slice(from, from + count).flatMap((rows) => rows.map((row) => row.id!));
    return {
      acceptedFoodEntryIds: ids(0, foodEntryChunks.length),
      acceptedRecipeIds: ids(foodEntryChunks.length, recipeChunks.length),
      acceptedSettings: settings ? (results[results.length - 1]?.length ?? 0) > 0 : false,
    };
  });

  return { bootstrap, push };
});

export class SyncRepository extends Context.Service<SyncRepository, Effect.Success<typeof make>>()(
  "caloric/sync/SyncRepository",
) {
  static readonly layer = Layer.effect(SyncRepository, make);
}
