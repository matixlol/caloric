import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BadRequest, NotFound } from "../api/Errors.ts";
import type { FoodEntry, UserSettings } from "../domain/Diary.ts";
import { friendshipId } from "../ids.ts";
import type {
  FriendDailyDayResponse,
  FriendDailyFoodEntry,
  FriendDailySummary,
  SocialOverview,
  SocialProfile,
} from "./Domain.ts";
import { SocialConflict } from "./Errors.ts";
import {
  FRIENDSHIP_ACCEPTED,
  FRIENDSHIP_PENDING,
  type OverviewRows,
  type ProfileRow,
  SocialRepository,
} from "./SocialRepository.ts";

const FRIEND_CODE_LENGTH = 6;
const FRIEND_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const FRIEND_CODE_ATTEMPTS = 12;
export const DEFAULT_DISPLAY_NAME = "Caloric friend";

const SUMMARY_KEYS = ["calories", "protein", "carbs", "fat"] as const;
const MEAL_ORDER = { breakfast: 0, lunch: 1, dinner: 2, snacks: 3 } as const;

// Every random friend code collided with an existing one.
export class FriendCodeUnavailable extends Data.TaggedError("FriendCodeUnavailable")<{}> {}

export const normalizeDisplayName = (value: string | undefined, fallback: string) =>
  value?.replace(/\s+/g, " ").trim() || fallback;

export const normalizeFriendCode = (value: string) => value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

const generateFriendCode = () =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(FRIEND_CODE_LENGTH)),
    (byte) => FRIEND_CODE_ALPHABET[byte % FRIEND_CODE_ALPHABET.length],
  ).join("");

interface DayEntryRow {
  readonly id: string;
  readonly data: FoodEntry;
  readonly updatedAt: Date;
}

// Totals a friend's day: nutrition times portion (a missing or invalid portion
// counts as 1), rounded per macro; lastUpdatedAt is the newest entry write.
export const summarizeDay = (
  base: { readonly userId: string; readonly displayName: string; readonly dateKey: string },
  settings: UserSettings | undefined,
  entries: ReadonlyArray<DayEntryRow>,
): FriendDailySummary => {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  let lastUpdatedAt: number | null = null;
  for (const { data, updatedAt } of entries) {
    const portion = Number.isFinite(data.portion) && data.portion > 0 ? data.portion : 1;
    for (const key of SUMMARY_KEYS) {
      totals[key] += (data.nutrition?.[key] ?? 0) * portion;
    }
    lastUpdatedAt = Math.max(lastUpdatedAt ?? 0, updatedAt.getTime());
  }
  for (const key of SUMMARY_KEYS) {
    totals[key] = Math.round(totals[key]);
  }
  return { ...base, ...totals, calorieGoal: settings?.calorieGoal ?? null, lastUpdatedAt };
};

const compareDayEntries = (a: FriendDailyFoodEntry, b: FriendDailyFoodEntry) =>
  MEAL_ORDER[a.meal] - MEAL_ORDER[b.meal] ||
  a.sortIndex - b.sortIndex ||
  a.createdAt - b.createdAt ||
  a.id.localeCompare(b.id);

// Each request reads (and writes) the database in one round trip: a D1 batch
// in SocialRepository. Only a user's first visit, which creates their
// profile, takes more.
const make = Effect.gen(function* () {
  const repository = yield* SocialRepository;

  // Creates the profile (with a fresh friend code) on first use, and renames
  // it when a different display name is given. Insert-or-nothing plus re-read
  // instead of a transaction: a lost race or a friend-code collision retries.
  const ensureProfile = Effect.fn("Social.ensureProfile")(function* (userId: string, displayName?: string) {
    for (let attempt = 0; attempt < FRIEND_CODE_ATTEMPTS; attempt += 1) {
      const existing = yield* repository.findProfile(userId);
      if (existing) {
        const nextDisplayName = normalizeDisplayName(displayName, existing.displayName);
        if (nextDisplayName === existing.displayName) {
          return existing;
        }
        yield* repository.rename(userId, nextDisplayName);
        return { ...existing, displayName: nextDisplayName };
      }
      const created = yield* repository.insertProfile({
        userId,
        displayName: normalizeDisplayName(displayName, DEFAULT_DISPLAY_NAME),
        friendCode: generateFriendCode(),
      });
      if (created) {
        return created;
      }
    }
    return yield* new FriendCodeUnavailable();
  });

  // The overview from its rows. A user without a profile yet gets one (a user
  // without a profile has no friendships: they reference profiles).
  const present = Effect.fn("Social.present")(function* (userId: string, rows: OverviewRows, displayName?: string) {
    const profile: ProfileRow = rows.profile ?? (yield* ensureProfile(userId, displayName));
    const otherUserId = (row: OverviewRows["friendships"][number]) =>
      row.friendship.userAId === userId ? row.friendship.userBId : row.friendship.userAId;
    const names = new Map(rows.friendships.map((row) => [otherUserId(row), row.otherDisplayName]));
    const profileFor = (id: string): SocialProfile => ({ userId: id, displayName: names.get(id) ?? DEFAULT_DISPLAY_NAME });

    const friends: Array<SocialOverview["friends"][number]> = [];
    const incomingRequests: Array<SocialOverview["incomingRequests"][number]> = [];
    const outgoingRequests: Array<SocialOverview["outgoingRequests"][number]> = [];
    for (const { friendship: row } of rows.friendships) {
      const other = row.userAId === userId ? row.userBId : row.userAId;
      if (row.status === FRIENDSHIP_ACCEPTED) {
        friends.push({ ...profileFor(other), since: row.updatedAt.getTime() });
      } else if (row.status === FRIENDSHIP_PENDING) {
        const request = { id: row.id, createdAt: row.createdAt.getTime() };
        if (row.recipientUserId === userId) {
          incomingRequests.push({ ...request, requester: profileFor(row.requesterUserId) });
        } else if (row.requesterUserId === userId) {
          outgoingRequests.push({ ...request, recipient: profileFor(row.recipientUserId) });
        }
      }
    }

    return {
      profile: { userId: profile.userId, displayName: profile.displayName, friendCode: profile.friendCode },
      friends: friends.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      incomingRequests: incomingRequests.sort((a, b) => a.createdAt - b.createdAt),
      outgoingRequests: outgoingRequests.sort((a, b) => a.createdAt - b.createdAt),
    } satisfies SocialOverview;
  });

  const overview = Effect.fn("Social.overview")(function* (userId: string) {
    return yield* present(userId, yield* repository.overview(userId));
  });

  // No name (or a blank one) keeps the current one.
  const updateProfile = Effect.fn("Social.updateProfile")(function* (userId: string, displayName?: string) {
    const name = displayName?.replace(/\s+/g, " ").trim();
    if (!name) {
      return yield* overview(userId);
    }
    return yield* present(userId, yield* repository.rename(userId, name), name);
  });

  // Sending a request to someone who already asked you accepts theirs.
  const sendFriendRequest = Effect.fn("Social.sendFriendRequest")(function* (userId: string, rawFriendCode: string) {
    const friendCode = normalizeFriendCode(rawFriendCode);
    // A second pass only happens when a concurrent request for the same pair
    // was inserted between our read and our insert.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const target = yield* repository.friendRequestTarget(userId, friendCode);
      if (!target.profile) {
        yield* ensureProfile(userId);
      }
      if (!friendCode) {
        return yield* new BadRequest({ error: "Invalid friend code" });
      }
      const { recipient, existing } = target;
      if (!recipient) {
        return yield* new NotFound({ error: "Friend code not found" });
      }
      if (recipient.userId === userId) {
        return yield* new BadRequest({ error: "You cannot add yourself" });
      }
      if (existing?.status === FRIENDSHIP_ACCEPTED) {
        return yield* new SocialConflict({ error: "Already friends" });
      }
      if (existing?.recipientUserId === userId) {
        return yield* present(userId, yield* repository.acceptRequest(existing.id, userId));
      }
      if (existing) {
        break;
      }
      const result = yield* repository.insertFriendRequest({
        id: friendshipId(),
        requesterUserId: userId,
        recipientUserId: recipient.userId,
      });
      if (result.inserted) {
        return yield* present(userId, result.overview);
      }
    }
    return yield* new SocialConflict({ error: "Friend request already pending" });
  });

  const acceptFriendRequest = Effect.fn("Social.acceptFriendRequest")(function* (userId: string, requestId: string) {
    return yield* present(userId, yield* repository.acceptRequest(requestId, userId));
  });

  const ignoreFriendRequest = Effect.fn("Social.ignoreFriendRequest")(function* (userId: string, requestId: string) {
    return yield* present(userId, yield* repository.deleteRequest(requestId, userId));
  });

  const removeFriend = Effect.fn("Social.removeFriend")(function* (userId: string, friendUserId: string) {
    return yield* present(userId, yield* repository.deleteFriendship(userId, friendUserId));
  });

  const dailySummaries = Effect.fn("Social.dailySummaries")(function* (userId: string, dateKey: string) {
    const { friends, entries, settings } = yield* repository.friendsDay(userId, dateKey);
    const settingsByUserId = new Map(settings.map((row) => [row.userId, row.data]));
    const entriesByUserId = new Map<string, Array<(typeof entries)[number]>>();
    for (const row of entries) {
      entriesByUserId.set(row.userId, [...(entriesByUserId.get(row.userId) ?? []), row]);
    }

    const summaries = friends
      .map((friend) =>
        summarizeDay(
          { userId: friend.userId, displayName: friend.displayName ?? DEFAULT_DISPLAY_NAME, dateKey },
          settingsByUserId.get(friend.userId),
          entriesByUserId.get(friend.userId) ?? [],
        ),
      )
      .sort((a, b) => b.calories - a.calories || a.displayName.localeCompare(b.displayName));
    return { summaries };
  });

  const friendDay = Effect.fn("Social.friendDay")(function* (userId: string, friendUserId: string, dateKey: string) {
    const { friend, entries, settings: settingsRows } = yield* repository.friendDay(userId, friendUserId, dateKey);
    if (!friend) {
      return yield* new NotFound({ error: "Friend not found" });
    }
    const settings = settingsRows[0]?.data;

    return {
      summary: summarizeDay(
        { userId: friendUserId, displayName: friend.displayName ?? DEFAULT_DISPLAY_NAME, dateKey },
        settings,
        entries,
      ),
      settings: settings ?? null,
      entries: entries
        .map((row): FriendDailyFoodEntry => ({ id: row.id, updatedAt: row.updatedAt.getTime(), ...row.data }))
        .sort(compareDayEntries),
    } satisfies FriendDailyDayResponse;
  });

  return {
    ensureProfile,
    overview,
    updateProfile,
    sendFriendRequest,
    acceptFriendRequest,
    ignoreFriendRequest,
    removeFriend,
    dailySummaries,
    friendDay,
  };
});

export class Social extends Context.Service<Social, Effect.Success<typeof make>>()("caloric/social/Social") {
  static readonly layer = Layer.effect(Social, make).pipe(Layer.provide(SocialRepository.layer));
}
