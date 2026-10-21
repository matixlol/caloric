import * as Schema from "effect/Schema";
import { CalorieGoal, FoodEntry, TimestampMs, UserSettings } from "../domain/Diary.ts";

// Effect Schema mirrors of the social contracts in @caloric/data-model. Keep
// the two in step when the social model changes.

const NonEmpty = Schema.NonEmptyString;

export const SocialProfile = Schema.Struct({ userId: NonEmpty, displayName: NonEmpty });
export type SocialProfile = typeof SocialProfile.Type;

export const SocialOverview = Schema.Struct({
  profile: Schema.Struct({ ...SocialProfile.fields, friendCode: NonEmpty }),
  friends: Schema.Array(Schema.Struct({ ...SocialProfile.fields, since: TimestampMs })),
  incomingRequests: Schema.Array(Schema.Struct({ id: NonEmpty, createdAt: TimestampMs, requester: SocialProfile })),
  outgoingRequests: Schema.Array(Schema.Struct({ id: NonEmpty, createdAt: TimestampMs, recipient: SocialProfile })),
});
export type SocialOverview = typeof SocialOverview.Type;

export const FriendDailySummary = Schema.Struct({
  ...SocialProfile.fields,
  dateKey: NonEmpty,
  calories: Schema.Finite,
  protein: Schema.Finite,
  carbs: Schema.Finite,
  fat: Schema.Finite,
  calorieGoal: Schema.NullOr(CalorieGoal),
  lastUpdatedAt: Schema.NullOr(TimestampMs),
});
export type FriendDailySummary = typeof FriendDailySummary.Type;

export const FriendDailySummariesResponse = Schema.Struct({ summaries: Schema.Array(FriendDailySummary) });

export const FriendDailyFoodEntry = Schema.Struct({ ...FoodEntry.fields, id: NonEmpty, updatedAt: TimestampMs });
export type FriendDailyFoodEntry = typeof FriendDailyFoodEntry.Type;

export const FriendDailyDayResponse = Schema.Struct({
  summary: FriendDailySummary,
  entries: Schema.Array(FriendDailyFoodEntry),
  settings: Schema.NullOr(UserSettings),
});
export type FriendDailyDayResponse = typeof FriendDailyDayResponse.Type;

// Request bodies, decoded strictly (unknown keys rejected) like backend/'s
// `.strict()` zod schemas so invalid payloads get the same 400 messages.

const TrimmedBetween = (max: number) =>
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(max));

export const ProfilePayload = Schema.Struct({ displayName: Schema.optionalKey(TrimmedBetween(80)) });
export const FriendCodePayload = Schema.Struct({ friendCode: TrimmedBetween(32) });
export const RequestIdPayload = Schema.Struct({ requestId: NonEmpty });

export const DateKey = Schema.Trim.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
