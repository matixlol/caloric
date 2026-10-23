import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type Batch, type BatchDb, Db, DbBatch, withRuntime } from "../db/Db.ts";
import { friendships, socialProfiles, userFoodEntries, userSettings } from "../db/schema.ts";

export const FRIENDSHIP_PENDING = "pending";
export const FRIENDSHIP_ACCEPTED = "accepted";

export type ProfileRow = typeof socialProfiles.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;
type FoodEntryRow = typeof userFoodEntries.$inferSelect;
type SettingsRow = typeof userSettings.$inferSelect;

// A friendship (or request) seen from one user, with the other user's name
// (null when they have no profile).
export interface FriendshipWithName {
  readonly friendship: FriendshipRow;
  readonly otherDisplayName: string | null;
}

// What every social screen shows: the user's profile and their friendships.
export interface OverviewRows {
  readonly profile: ProfileRow | undefined;
  readonly friendships: ReadonlyArray<FriendshipWithName>;
}

export const sortUserPair = (userId: string, otherUserId: string) =>
  userId < otherUserId ? { userAId: userId, userBId: otherUserId } : { userAId: otherUserId, userBId: userId };

// The other side of a friendship row, from `userId`'s point of view.
const otherUserIdOf = (userId: string) =>
  sql<string>`case when ${friendships.userAId} = ${userId} then ${friendships.userBId} else ${friendships.userAId} end`;

const involves = (userId: string) => or(eq(friendships.userAId, userId), eq(friendships.userBId, userId));

const isPair = (userId: string, otherUserId: string) => {
  const { userAId, userBId } = sortUserPair(userId, otherUserId);
  return and(eq(friendships.userAId, userAId), eq(friendships.userBId, userBId));
};

// Only the recipient can accept or ignore a pending request; requests that
// don't match are left alone (backend/ answered with the overview anyway).
const pendingForRecipient = (requestId: string, recipientUserId: string) =>
  and(
    eq(friendships.id, requestId),
    eq(friendships.recipientUserId, recipientUserId),
    eq(friendships.status, FRIENDSHIP_PENDING),
  );

// --- Query builders (each request runs its queries as one D1 batch) ----------

const ownProfile = (q: BatchDb, userId: string) =>
  q.select().from(socialProfiles).where(eq(socialProfiles.userId, userId)).limit(1);

const friendshipsWithNames = (q: BatchDb, userId: string) =>
  q
    .select({ friendship: friendships, otherDisplayName: socialProfiles.displayName })
    .from(friendships)
    .leftJoin(socialProfiles, eq(socialProfiles.userId, otherUserIdOf(userId)))
    .where(involves(userId));

const acceptedFriendIds = (q: BatchDb, userId: string) =>
  q
    .select({ id: otherUserIdOf(userId) })
    .from(friendships)
    .where(and(eq(friendships.status, FRIENDSHIP_ACCEPTED), involves(userId)));

const dayEntries = (q: BatchDb, userIds: ReturnType<typeof acceptedFriendIds>, dateKey: string, only?: string) =>
  q
    .select()
    .from(userFoodEntries)
    .where(
      and(
        only ? eq(userFoodEntries.userId, only) : undefined,
        inArray(userFoodEntries.userId, userIds),
        isNull(userFoodEntries.deletedAt),
        sql`json_extract(${userFoodEntries.data}, '$.dateKey') = ${dateKey}`,
      ),
    );

const settingsOf = (q: BatchDb, userIds: ReturnType<typeof acceptedFriendIds>, only?: string) =>
  q
    .select()
    .from(userSettings)
    .where(and(only ? eq(userSettings.userId, only) : undefined, inArray(userSettings.userId, userIds)));

const make = Effect.gen(function* () {
  const db = yield* Db;
  const batch = yield* DbBatch;

  // Runs `writes` and then reads the overview, in one round trip. Returns the
  // writes' results (in order) and the overview rows.
  const withOverview = Effect.fn("SocialRepository.withOverview")(function* (
    userId: string,
    writes: (q: BatchDb) => ReadonlyArray<BatchItem<"sqlite">> = () => [],
  ) {
    let writeCount = 0;
    const results = (yield* batch.run((q) => {
      const statements = writes(q);
      writeCount = statements.length;
      return [...statements, ownProfile(q, userId), friendshipsWithNames(q, userId)] as unknown as Batch;
    })) as unknown as ReadonlyArray<ReadonlyArray<unknown>>;
    return {
      writes: results.slice(0, writeCount),
      overview: {
        profile: results[writeCount]![0] as ProfileRow | undefined,
        friendships: results[writeCount + 1] as ReadonlyArray<FriendshipWithName>,
      } satisfies OverviewRows,
    };
  });

  const overview = (userId: string) => withOverview(userId).pipe(Effect.map((result) => result.overview));

  const rename = (userId: string, displayName: string) =>
    withOverview(userId, (q) => [
      q
        .update(socialProfiles)
        .set({ displayName, updatedAt: new Date() })
        .where(and(eq(socialProfiles.userId, userId), ne(socialProfiles.displayName, displayName))),
    ]).pipe(Effect.map((result) => result.overview));

  const acceptRequest = (requestId: string, recipientUserId: string) =>
    withOverview(recipientUserId, (q) => [
      q
        .update(friendships)
        .set({ status: FRIENDSHIP_ACCEPTED, updatedAt: new Date() })
        .where(pendingForRecipient(requestId, recipientUserId)),
    ]).pipe(Effect.map((result) => result.overview));

  const deleteRequest = (requestId: string, recipientUserId: string) =>
    withOverview(recipientUserId, (q) => [q.delete(friendships).where(pendingForRecipient(requestId, recipientUserId))]).pipe(
      Effect.map((result) => result.overview),
    );

  const deleteFriendship = (userId: string, friendUserId: string) =>
    withOverview(userId, (q) => [
      q.delete(friendships).where(and(isPair(userId, friendUserId), eq(friendships.status, FRIENDSHIP_ACCEPTED))),
    ]).pipe(Effect.map((result) => result.overview));

  // Inserts a pending request, then reads the overview. `inserted` is false
  // when the pair already has a row (a concurrent request won the race).
  const insertFriendRequest = (request: {
    readonly id: string;
    readonly requesterUserId: string;
    readonly recipientUserId: string;
  }) => {
    const now = new Date();
    return withOverview(request.requesterUserId, (q) => [
      q
        .insert(friendships)
        .values({
          ...request,
          ...sortUserPair(request.requesterUserId, request.recipientUserId),
          status: FRIENDSHIP_PENDING,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: friendships.id }),
    ]).pipe(
      Effect.map((result) => ({ inserted: (result.writes[0]?.length ?? 0) > 0, overview: result.overview })),
    );
  };

  // Everything sending a friend request decides on: the sender's profile, the
  // friend code's owner, and any row between the two.
  const friendRequestTarget = Effect.fn("SocialRepository.friendRequestTarget")(function* (
    userId: string,
    friendCode: string,
  ) {
    const [profile, recipient, existing] = yield* batch.run((q) => {
      const codeOwner = q
        .select({ userId: socialProfiles.userId })
        .from(socialProfiles)
        .where(eq(socialProfiles.friendCode, friendCode));
      return [
        ownProfile(q, userId),
        q.select().from(socialProfiles).where(eq(socialProfiles.friendCode, friendCode)).limit(1),
        q
          .select()
          .from(friendships)
          .where(
            or(
              and(eq(friendships.userAId, userId), inArray(friendships.userBId, codeOwner)),
              and(eq(friendships.userBId, userId), inArray(friendships.userAId, codeOwner)),
            ),
          )
          .limit(1),
      ];
    });
    return { profile: profile[0], recipient: recipient[0], existing: existing[0] };
  });

  // Accepted friends with their names, and their entries and settings for the
  // day. The friend list is a subquery, so this is one round trip.
  const friendsDay = Effect.fn("SocialRepository.friendsDay")(function* (userId: string, dateKey: string) {
    const [friends, entries, settings] = yield* batch.run((q) => [
      q
        .select({ userId: otherUserIdOf(userId), displayName: socialProfiles.displayName })
        .from(friendships)
        .leftJoin(socialProfiles, eq(socialProfiles.userId, otherUserIdOf(userId)))
        .where(and(eq(friendships.status, FRIENDSHIP_ACCEPTED), involves(userId))),
      dayEntries(q, acceptedFriendIds(q, userId), dateKey),
      settingsOf(q, acceptedFriendIds(q, userId)),
    ]);
    return {
      friends: friends as ReadonlyArray<{ readonly userId: string; readonly displayName: string | null }>,
      entries: entries as ReadonlyArray<FoodEntryRow>,
      settings: settings as ReadonlyArray<SettingsRow>,
    };
  });

  // One friend's day; `friend` is undefined unless they are an accepted friend
  // (and then entries and settings are empty too).
  const friendDay = Effect.fn("SocialRepository.friendDay")(function* (
    userId: string,
    friendUserId: string,
    dateKey: string,
  ) {
    const [friend, entries, settings] = yield* batch.run((q) => [
      q
        .select({ displayName: socialProfiles.displayName })
        .from(friendships)
        .leftJoin(socialProfiles, eq(socialProfiles.userId, friendUserId))
        .where(and(isPair(userId, friendUserId), eq(friendships.status, FRIENDSHIP_ACCEPTED)))
        .limit(1),
      dayEntries(q, acceptedFriendIds(q, userId), dateKey, friendUserId),
      settingsOf(q, acceptedFriendIds(q, userId), friendUserId),
    ]);
    return {
      friend: friend[0] as { readonly displayName: string | null } | undefined,
      entries: entries as ReadonlyArray<FoodEntryRow>,
      settings: settings as ReadonlyArray<SettingsRow>,
    };
  });

  // --- First use only: creating a profile --------------------------------------

  const findProfile = Effect.fn("SocialRepository.findProfile")(function* (userId: string) {
    const rows = yield* db.select().from(socialProfiles).where(eq(socialProfiles.userId, userId)).limit(1);
    return rows[0];
  }, withRuntime);

  // Does nothing (returns undefined) when the user already has a profile or
  // the friend code is taken; the caller re-reads and retries.
  const insertProfile = Effect.fn("SocialRepository.insertProfile")(function* (profile: {
    readonly userId: string;
    readonly displayName: string;
    readonly friendCode: string;
  }) {
    const now = new Date();
    const rows = yield* db
      .insert(socialProfiles)
      .values({ ...profile, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    return rows[0];
  }, withRuntime);

  return {
    overview,
    rename,
    acceptRequest,
    deleteRequest,
    deleteFriendship,
    insertFriendRequest,
    friendRequestTarget,
    friendsDay,
    friendDay,
    findProfile,
    insertProfile,
  };
});

export class SocialRepository extends Context.Service<SocialRepository, Effect.Success<typeof make>>()(
  "caloric/social/SocialRepository",
) {
  static readonly layer = Layer.effect(SocialRepository, make);
}
