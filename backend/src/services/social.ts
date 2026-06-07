import {
  FriendDailySummariesResponseSchema,
  type FoodEntry,
  type SocialOverview,
  SocialOverviewSchema,
  type UserSettings,
} from "@caloric/data-model";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db";
import { friendships, socialProfiles, userFoodEntries, userSettings } from "../db/schema";
import { jsonResponse, requireAuthenticatedUser } from "../http";
import { createFriendshipId } from "../id";
import { Sentry } from "../lib/sentry";

const FRIENDSHIP_STATUS_PENDING = "pending";
const FRIENDSHIP_STATUS_ACCEPTED = "accepted";
const FRIEND_CODE_LENGTH = 6;
const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DEFAULT_DISPLAY_NAME = "Caloric friend";
const INVALID_FRIEND_REQUEST_PAYLOAD = "Invalid friend request payload";
const SUMMARY_KEYS = ["calories", "protein", "carbs", "fat"] as const;
const profilePayloadSchema = z.object({ displayName: z.string().trim().min(1).max(80).optional() }).strict();
const friendCodePayloadSchema = z.object({ friendCode: z.string().trim().min(1).max(32) }).strict();
const requestIdPayloadSchema = z.object({ requestId: z.string().min(1) }).strict();

async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  return schema.parse(await c.req.json().catch(() => null));
}

function authedRoute(
  handler: (userId: string, c: Context) => Promise<Response>,
  errorCode: string,
  invalidPayloadError?: string,
) {
  return async (c: Context) => {
    const auth = await requireAuthenticatedUser(c.req.raw);
    if (auth instanceof Response) {
      return auth;
    }

    try {
      return await handler(auth.userId, c);
    } catch (error) {
      if (invalidPayloadError && error instanceof z.ZodError) {
        return jsonResponse({ error: invalidPayloadError }, 400);
      }

      return reportUnknownError(errorCode, error);
    }
  };
}

async function overviewResponse(userId: string): Promise<Response> {
  return jsonResponse(await loadSocialOverview(userId));
}

function reportUnknownError(code: string, error: unknown): Response {
  Sentry.captureException(error);
  return jsonResponse({ error: code, message: "Unknown error." }, 502);
}

const normalizeDisplayName = (value: string | undefined, fallback: string) =>
  value?.replace(/\s+/g, " ").trim() || fallback;

const normalizeFriendCode = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

const sortUserPair = (userId: string, otherUserId: string) =>
  userId < otherUserId
    ? { userAId: userId, userBId: otherUserId }
    : { userAId: otherUserId, userBId: userId };

function generateFriendCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(FRIEND_CODE_LENGTH)), (byte) =>
    FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length]).join("");
}

async function createUniqueFriendCode(): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const friendCode = generateFriendCode();
    const existing = await db
      .select({ userId: socialProfiles.userId })
      .from(socialProfiles)
      .where(eq(socialProfiles.friendCode, friendCode))
      .limit(1);

    if (!existing[0]) {
      return friendCode;
    }
  }

  throw new Error("Could not generate a unique friend code");
}

async function getOrCreateSocialProfile(userId: string, displayName?: string) {
  const existing = (await db
    .select()
    .from(socialProfiles)
    .where(eq(socialProfiles.userId, userId))
    .limit(1))[0];

  const nextDisplayName = normalizeDisplayName(displayName, existing?.displayName ?? DEFAULT_DISPLAY_NAME);

  if (existing) {
    if (nextDisplayName !== existing.displayName) {
      const updatedAt = new Date();
      await db
        .update(socialProfiles)
        .set({ displayName: nextDisplayName, updatedAt })
        .where(eq(socialProfiles.userId, userId));

      return { ...existing, displayName: nextDisplayName, updatedAt };
    }

    return existing;
  }

  const friendCode = await createUniqueFriendCode();
  const now = new Date();

  await db.insert(socialProfiles).values({
    userId,
    displayName: nextDisplayName,
    friendCode,
    createdAt: now,
    updatedAt: now,
  });

  return {
    userId,
    displayName: nextDisplayName,
    friendCode,
    updatedAt: now,
  };
}

const publicProfile = (row: { userId: string; displayName: string }) => ({
  userId: row.userId,
  displayName: row.displayName,
});

const fallbackProfile = (userId: string) => ({ userId, displayName: DEFAULT_DISPLAY_NAME });

async function loadSocialOverview(userId: string) {
  const [profile, relationshipRows] = await Promise.all([
    getOrCreateSocialProfile(userId),
    db
      .select()
      .from(friendships)
      .where(or(eq(friendships.userAId, userId), eq(friendships.userBId, userId))),
  ]);

  const otherUserIds = [...new Set(relationshipRows.map((row) => (row.userAId === userId ? row.userBId : row.userAId)))];

  const profiles = otherUserIds.length
    ? await db
        .select()
        .from(socialProfiles)
        .where(inArray(socialProfiles.userId, otherUserIds))
    : [];
  const profilesByUserId = new Map(profiles.map((row) => [row.userId, row] as const));
  const profileFor = (profileUserId: string) =>
    publicProfile(profilesByUserId.get(profileUserId) ?? fallbackProfile(profileUserId));
  const friends: SocialOverview["friends"] = [];
  const incomingRequests: SocialOverview["incomingRequests"] = [];
  const outgoingRequests: SocialOverview["outgoingRequests"] = [];

  for (const row of relationshipRows) {
    const otherUserId = row.userAId === userId ? row.userBId : row.userAId;
    if (row.status === FRIENDSHIP_STATUS_ACCEPTED) {
      friends.push({ ...profileFor(otherUserId), since: row.updatedAt.getTime() });
    } else if (row.status === FRIENDSHIP_STATUS_PENDING) {
      const request = { id: row.id, createdAt: row.createdAt.getTime() };
      if (row.recipientUserId === userId) {
        incomingRequests.push({ ...request, requester: profileFor(row.requesterUserId) });
      } else if (row.requesterUserId === userId) {
        outgoingRequests.push({ ...request, recipient: profileFor(row.recipientUserId) });
      }
    }
  }

  return SocialOverviewSchema.parse({
    profile: {
      userId: profile.userId,
      displayName: profile.displayName,
      friendCode: profile.friendCode,
    },
    friends: friends.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    incomingRequests: incomingRequests.sort((a, b) => a.createdAt - b.createdAt),
    outgoingRequests: outgoingRequests.sort((a, b) => a.createdAt - b.createdAt),
  });
}

async function getAcceptedFriendIds(userId: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(friendships)
    .where(
      and(
        eq(friendships.status, FRIENDSHIP_STATUS_ACCEPTED),
        or(eq(friendships.userAId, userId), eq(friendships.userBId, userId)),
      ),
    );

  return rows.map((row) => (row.userAId === userId ? row.userBId : row.userAId));
}

function addFoodEntryToSummary(summary: {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}, entry: FoodEntry) {
  const portion = Number.isFinite(entry.portion) && entry.portion > 0 ? entry.portion : 1;
  for (const key of SUMMARY_KEYS) {
    summary[key] += (entry.nutrition?.[key] ?? 0) * portion;
  }
}

export const socialRoutes = new Hono();

socialRoutes.get("/me", authedRoute(overviewResponse, "social_overview_failed"));

function pendingRequestWhere(requestId: string, userId: string) {
  return and(
    eq(friendships.id, requestId),
    eq(friendships.recipientUserId, userId),
    eq(friendships.status, FRIENDSHIP_STATUS_PENDING),
  );
}

function friendRequestActionRoute(
  path: string,
  errorCode: string,
  action: (requestId: string, userId: string) => Promise<unknown>,
) {
  socialRoutes.post(
    path,
    authedRoute(async (userId, c) => {
      const { requestId } = await parseJson(c, requestIdPayloadSchema);
      await action(requestId, userId);
      return overviewResponse(userId);
    }, errorCode, INVALID_FRIEND_REQUEST_PAYLOAD),
  );
}

socialRoutes.post(
  "/profile",
  authedRoute(
    async (userId, c) => {
      const { displayName } = await parseJson(c, profilePayloadSchema);
      await getOrCreateSocialProfile(userId, displayName);

      return overviewResponse(userId);
    },
    "social_profile_failed",
    "Invalid profile payload",
  ),
);

socialRoutes.post(
  "/friend-requests",
  authedRoute(
    async (userId, c) => {
      await getOrCreateSocialProfile(userId);
      const { friendCode: rawFriendCode } = await parseJson(c, friendCodePayloadSchema);
      const friendCode = normalizeFriendCode(rawFriendCode);

      if (!friendCode) {
        return jsonResponse({ error: "Invalid friend code" }, 400);
      }

      const recipient = (await db
        .select()
        .from(socialProfiles)
        .where(eq(socialProfiles.friendCode, friendCode))
        .limit(1))[0];

      if (!recipient) {
        return jsonResponse({ error: "Friend code not found" }, 404);
      }

      if (recipient.userId === userId) {
        return jsonResponse({ error: "You cannot add yourself" }, 400);
      }

      const { userAId, userBId } = sortUserPair(userId, recipient.userId);
      const existing = (await db
        .select()
        .from(friendships)
        .where(and(eq(friendships.userAId, userAId), eq(friendships.userBId, userBId)))
        .limit(1))[0];

      if (existing?.status === FRIENDSHIP_STATUS_ACCEPTED) {
        return jsonResponse({ error: "Already friends" }, 409);
      }

      if (existing?.recipientUserId === userId) {
        await db
          .update(friendships)
          .set({ status: FRIENDSHIP_STATUS_ACCEPTED, updatedAt: new Date() })
          .where(eq(friendships.id, existing.id));

        return overviewResponse(userId);
      }

      if (existing) {
        return jsonResponse({ error: "Friend request already pending" }, 409);
      }

      await db.insert(friendships).values({
        id: createFriendshipId(),
        requesterUserId: userId,
        recipientUserId: recipient.userId,
        userAId,
        userBId,
        status: FRIENDSHIP_STATUS_PENDING,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return overviewResponse(userId);
    },
    "social_friend_request_failed",
    INVALID_FRIEND_REQUEST_PAYLOAD,
  ),
);

friendRequestActionRoute(
  "/friend-requests/accept",
  "social_accept_request_failed",
  async (requestId, userId) => {
    await db
      .update(friendships)
      .set({
        status: FRIENDSHIP_STATUS_ACCEPTED,
        updatedAt: new Date(),
      })
      .where(pendingRequestWhere(requestId, userId));
  },
);

friendRequestActionRoute(
  "/friend-requests/ignore",
  "social_ignore_request_failed",
  async (requestId, userId) => {
    await db.delete(friendships).where(pendingRequestWhere(requestId, userId));
  },
);

socialRoutes.delete(
  "/friends/:friendUserId",
  authedRoute(async (userId, c) => {
    const friendUserId = c.req.param("friendUserId");
    if (!friendUserId) {
      return jsonResponse({ error: "Invalid friend id" }, 400);
    }

    const { userAId, userBId } = sortUserPair(userId, friendUserId);
    await db
      .delete(friendships)
      .where(
        and(
          eq(friendships.userAId, userAId),
          eq(friendships.userBId, userBId),
          eq(friendships.status, FRIENDSHIP_STATUS_ACCEPTED),
        ),
      );

    return overviewResponse(userId);
  }, "social_remove_friend_failed"),
);

socialRoutes.get(
  "/daily-summaries",
  authedRoute(async (userId, c) => {
    const dateKey = new URL(c.req.raw.url).searchParams.get("dateKey")?.trim();

    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return jsonResponse({ error: "Invalid dateKey" }, 400);
    }

    const friendUserIds = await getAcceptedFriendIds(userId);
    if (friendUserIds.length === 0) {
      return jsonResponse(FriendDailySummariesResponseSchema.parse({ summaries: [] }));
    }

    const [profiles, entries, settingsRows] = await Promise.all([
      db
        .select()
        .from(socialProfiles)
        .where(inArray(socialProfiles.userId, friendUserIds)),
      db
        .select()
        .from(userFoodEntries)
        .where(
          and(
            inArray(userFoodEntries.userId, friendUserIds),
            isNull(userFoodEntries.deletedAt),
            sql`${userFoodEntries.data}->>'dateKey' = ${dateKey}`,
          ),
        ),
      db
        .select()
        .from(userSettings)
        .where(inArray(userSettings.userId, friendUserIds)),
    ]);

    const profilesByUserId = new Map(profiles.map((row) => [row.userId, row] as const));
    const settingsByUserId = new Map<string, UserSettings>(settingsRows.map((row) => [row.userId, row.data] as const));
    const summariesByUserId = new Map(
      friendUserIds.map((friendUserId) => [
        friendUserId,
        {
          userId: friendUserId,
          displayName: profilesByUserId.get(friendUserId)?.displayName ?? DEFAULT_DISPLAY_NAME,
          dateKey,
          calories: 0,
          protein: 0,
          carbs: 0,
          fat: 0,
          calorieGoal: settingsByUserId.get(friendUserId)?.calorieGoal ?? null,
          lastUpdatedAt: null as number | null,
        },
      ]),
    );

    for (const row of entries) {
      const summary = summariesByUserId.get(row.userId);
      if (summary) {
        addFoodEntryToSummary(summary, row.data);
        summary.lastUpdatedAt = Math.max(summary.lastUpdatedAt ?? 0, row.updatedAt.getTime());
      }
    }

    return jsonResponse(FriendDailySummariesResponseSchema.parse({
      summaries: Array.from(summariesByUserId.values())
        .map((summary) => {
          for (const key of SUMMARY_KEYS) summary[key] = Math.round(summary[key]);
          return summary;
        })
        .sort((a, b) => b.calories - a.calories || a.displayName.localeCompare(b.displayName)),
    }));
  }, "social_daily_summaries_failed"),
);
