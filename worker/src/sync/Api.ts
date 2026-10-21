import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Authentication } from "../api/Authentication.ts";
import { BadRequest, UpstreamFailure } from "../api/Errors.ts";
import { FoodEntry, Recipe, TimestampMs, USER_SETTINGS_ROW_ID, UserSettings } from "../domain/Diary.ts";

const Row = <A extends Schema.Top>(data: A) =>
  Schema.Struct({
    id: Schema.NonEmptyString,
    data,
    updatedAt: TimestampMs,
    deletedAt: Schema.optionalKey(Schema.NullOr(TimestampMs)),
  });

export const SyncFoodEntryRow = Row(FoodEntry);
export const SyncRecipeRow = Row(Recipe);
export const SyncSettingsRow = Schema.Struct({
  id: Schema.Literal(USER_SETTINGS_ROW_ID),
  data: UserSettings,
  updatedAt: TimestampMs,
});

const StoredRow = <A extends Schema.Top>(data: A) =>
  Schema.Struct({ id: Schema.String, data, updatedAt: TimestampMs });

export const SyncPushPayload = Schema.Struct({
  foodEntries: Schema.Array(SyncFoodEntryRow).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  recipes: Schema.Array(SyncRecipeRow).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  settings: Schema.optionalKey(Schema.NullOr(SyncSettingsRow)),
});

export class SyncGroup extends HttpApiGroup.make("sync")
  .add(
    HttpApiEndpoint.get("bootstrap", "/bootstrap", {
      success: Schema.Struct({
        foodEntries: Schema.Array(StoredRow(FoodEntry)),
        recipes: Schema.Array(StoredRow(Recipe)),
        settings: Schema.NullOr(StoredRow(UserSettings)),
      }),
      error: UpstreamFailure,
    }),
    HttpApiEndpoint.post("push", "/push", {
      payload: SyncPushPayload,
      success: Schema.Struct({
        acceptedFoodEntryIds: Schema.Array(Schema.String),
        acceptedRecipeIds: Schema.Array(Schema.String),
        acceptedSettings: Schema.Boolean,
      }),
      error: [BadRequest, UpstreamFailure],
    }),
  )
  .middleware(Authentication)
  .prefix("/sync") {}
