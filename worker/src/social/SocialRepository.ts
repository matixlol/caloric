import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Db, withRuntime } from "../db/Db.ts";
import { friendships, socialProfiles, userFoodEntries, userSettings } from "../db/schema.ts";

export const FRIENDSHIP_PENDING = "pending";
export const FRIENDSHIP_ACCEPTED = "accepted";

export type ProfileRow = typeof socialProfiles.$inferSelect;
export type FriendshipRow = typeof friendships.$inferSelect;

// D1 binds at most 100 parameters per statement; id lists are queried in
// chunks that leave room for the statement's other parameters.
const CHUNK_SIZE = 90;

const chunks = <A>(items: ReadonlyArray<A>): Array<Array<A>> => {
  const result: Array<Array<A>> = [];
  for (let start = 0; start < items.length; start += CHUNK_SIZE) {
    result.push(items.slice(start, start + CHUNK_SIZE));
  }
  return result;
};

export const sortUserPair = (userId: string, otherUserId: string) =>
  userId < otherUserId ? { userAId: userId, userBId: otherUserId } : { userAId: otherUserId, userBId: userId };

const make = Effect.gen(function* () {
  const db = yield* Db;

  const byChunks = <A, E, R>(ids: ReadonlyArray<string>, query: (chunk: Array<string>) => Effect.Effect<Array<A>, E, R>) =>
    Effect.forEach(chunks(ids), query, { concurrency: "unbounded" }).pipe(Effect.map((rows) => rows.flat()));

  const findProfile = Effect.fn("SocialRepository.findProfile")(function* (userId: string) {
    const rows = yield* db.select().from(socialProfiles).where(eq(socialProfiles.userId, userId)).limit(1);
    return rows[0];
  }, withRuntime);

  const findProfileByFriendCode = Effect.fn("SocialRepository.findProfileByFriendCode")(function* (friendCode: string) {
    const rows = yield* db.select().from(socialProfiles).where(eq(socialProfiles.friendCode, friendCode)).limit(1);
    return rows[0];
  }, withRuntime);

  const findProfiles = Effect.fn("SocialRepository.findProfiles")(function* (userIds: ReadonlyArray<string>) {
    return yield* byChunks(userIds, (chunk) =>
      db.select().from(socialProfiles).where(inArray(socialProfiles.userId, chunk)),
    );
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

  const updateDisplayName = Effect.fn("SocialRepository.updateDisplayName")(function* (
    userId: string,
    displayName: string,
    updatedAt: Date,
  ) {
    yield* db.update(socialProfiles).set({ displayName, updatedAt }).where(eq(socialProfiles.userId, userId));
  }, withRuntime);

  const listFriendships = Effect.fn("SocialRepository.listFriendships")(function* (userId: string) {
    return yield* db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)));
  }, withRuntime);

  const listAcceptedFriendIds = Effect.fn("SocialRepository.listAcceptedFriendIds")(function* (userId: string) {
    const rows = yield* db
      .select({ userAId: friendships.userAId, userBId: friendships.userBId })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, FRIENDSHIP_ACCEPTED),
          or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)),
        ),
      );
    return rows.map((row) => (row.userAId === userId ? row.userBId : row.userAId));
  }, withRuntime);

  const findFriendship = Effect.fn("SocialRepository.findFriendship")(function* (userId: string, otherUserId: string) {
    const { userAId, userBId } = sortUserPair(userId, otherUserId);
    const rows = yield* db
      .select()
      .from(friendships)
      .where(and(eq(friendships.userAId, userAId), eq(friendships.userBId, userBId)))
      .limit(1);
    return rows[0];
  }, withRuntime);

  // False when the pair already has a row (a concurrent request won the race).
  const insertFriendRequest = Effect.fn("SocialRepository.insertFriendRequest")(function* (request: {
    readonly id: string;
    readonly requesterUserId: string;
    readonly recipientUserId: string;
  }) {
    const now = new Date();
    const rows = yield* db
      .insert(friendships)
      .values({
        ...request,
        ...sortUserPair(request.requesterUserId, request.recipientUserId),
        status: FRIENDSHIP_PENDING,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: friendships.id });
    return rows.length > 0;
  }, withRuntime);

  // Only the recipient can accept or ignore a pending request; requests that
  // don't match are left alone (backend/ answered with the overview anyway).
  const pendingForRecipient = (requestId: string, recipientUserId: string) =>
    and(
      eq(friendships.id, requestId),
      eq(friendships.recipientUserId, recipientUserId),
      eq(friendships.status, FRIENDSHIP_PENDING),
    );

  const acceptRequest = Effect.fn("SocialRepository.acceptRequest")(function* (
    requestId: string,
    recipientUserId: string,
  ) {
    yield* db
      .update(friendships)
      .set({ status: FRIENDSHIP_ACCEPTED, updatedAt: new Date() })
      .where(pendingForRecipient(requestId, recipientUserId));
  }, withRuntime);

  const deleteRequest = Effect.fn("SocialRepository.deleteRequest")(function* (
    requestId: string,
    recipientUserId: string,
  ) {
    yield* db.delete(friendships).where(pendingForRecipient(requestId, recipientUserId));
  }, withRuntime);

  const deleteFriendship = Effect.fn("SocialRepository.deleteFriendship")(function* (
    userId: string,
    friendUserId: string,
  ) {
    const { userAId, userBId } = sortUserPair(userId, friendUserId);
    yield* db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          eq(friendships.status, FRIENDSHIP_ACCEPTED),
        ),
      );
  }, withRuntime);

  const isAcceptedFriend = Effect.fn("SocialRepository.isAcceptedFriend")(function* (
    userId: string,
    friendUserId: string,
  ) {
    const { userAId, userBId } = sortUserPair(userId, friendUserId);
    const rows = yield* db
      .select({ id: friendships.id })
      .from(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          eq(friendships.status, FRIENDSHIP_ACCEPTED),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }, withRuntime);

  const listFoodEntriesForDay = Effect.fn("SocialRepository.listFoodEntriesForDay")(function* (
    userIds: ReadonlyArray<string>,
    dateKey: string,
  ) {
    return yield* byChunks(userIds, (chunk) =>
      db
        .select()
        .from(userFoodEntries)
        .where(
          and(
            inArray(userFoodEntries.userId, chunk),
            isNull(userFoodEntries.deletedAt),
            sql`json_extract(${userFoodEntries.data}, '$.dateKey') = ${dateKey}`,
          ),
        ),
    );
  }, withRuntime);

  const listSettings = Effect.fn("SocialRepository.listSettings")(function* (userIds: ReadonlyArray<string>) {
    return yield* byChunks(userIds, (chunk) =>
      db.select().from(userSettings).where(inArray(userSettings.userId, chunk)),
    );
  }, withRuntime);

  return {
    findProfile,
    findProfileByFriendCode,
    findProfiles,
    insertProfile,
    updateDisplayName,
    listFriendships,
    listAcceptedFriendIds,
    findFriendship,
    insertFriendRequest,
    acceptRequest,
    deleteRequest,
    deleteFriendship,
    isAcceptedFriend,
    listFoodEntriesForDay,
    listSettings,
  };
});

export class SocialRepository extends Context.Service<SocialRepository, Effect.Success<typeof make>>()(
  "caloric/social/SocialRepository",
) {
  static readonly layer = Layer.effect(SocialRepository, make);
}
