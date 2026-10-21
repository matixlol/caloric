import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { FoodEntry } from "../src/domain/Diary.ts";
import {
  DateKey,
  FriendCodePayload,
  FriendDailyDayResponse,
  FriendDailySummariesResponse,
  ProfilePayload,
  SocialOverview,
} from "../src/social/Domain.ts";
import { DEFAULT_DISPLAY_NAME, normalizeFriendCode, Social, summarizeDay } from "../src/social/Social.ts";
import { SyncRepository } from "../src/sync/SyncRepository.ts";
import { TestDb } from "./TestDb.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Social | SyncRepository>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(Social.layer, SyncRepository.layer).pipe(Layer.provide(TestDb)))),
  );

const entry = (overrides: Partial<FoodEntry> = {}): FoodEntry => ({
  meal: "lunch",
  foodName: "Apple",
  portion: 1,
  createdAt: 1,
  dateKey: "2026-10-21",
  sortIndex: 0,
  ...overrides,
});

const settings = { calorieGoal: 2000, macroProteinPct: 30, macroCarbsPct: 40, macroFatPct: 30 };

// Creates profiles for both users and makes them friends; returns their overviews.
const befriend = (social: Social["Service"], a: string, b: string) =>
  Effect.gen(function* () {
    const bProfile = yield* social.ensureProfile(b);
    const sent = yield* social.sendFriendRequest(a, bProfile.friendCode);
    const requestId = sent.outgoingRequests[0]!.id;
    return yield* social.acceptFriendRequest(b, requestId);
  });

describe("Social", () => {
  test("creates a profile with a friend code and renames it", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const first = yield* social.overview("u1");
        expect(first.profile.displayName).toBe(DEFAULT_DISPLAY_NAME);
        expect(first.profile.friendCode).toMatch(/^[23456789A-HJ-NP-Z]{6}$/);
        expect(first).toEqual({ profile: first.profile, friends: [], incomingRequests: [], outgoingRequests: [] });

        const renamed = yield* social.updateProfile("u1", "  Ada \n Lovelace ");
        expect(renamed.profile).toEqual({ userId: "u1", displayName: "Ada Lovelace", friendCode: first.profile.friendCode });

        // No name keeps the current one.
        const unchanged = yield* social.updateProfile("u1");
        expect(unchanged.profile.displayName).toBe("Ada Lovelace");
      }),
    ));

  test("friend request lifecycle: send, only the recipient accepts, remove", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        yield* social.updateProfile("alice", "Alice");
        const bob = yield* social.updateProfile("bob", "Bob");

        const sent = yield* social.sendFriendRequest("alice", ` ${bob.profile.friendCode.toLowerCase().slice(0, 3)}-${bob.profile.friendCode.slice(3)} `);
        expect(sent.outgoingRequests).toEqual([
          { id: expect.stringMatching(/^friendship_/), createdAt: expect.any(Number), recipient: { userId: "bob", displayName: "Bob" } },
        ]);
        const requestId = sent.outgoingRequests[0]!.id;

        const bobView = yield* social.overview("bob");
        expect(bobView.incomingRequests).toEqual([
          { id: requestId, createdAt: sent.outgoingRequests[0]!.createdAt, requester: { userId: "alice", displayName: "Alice" } },
        ]);

        // The requester can't accept (or ignore) their own request.
        const selfAccept = yield* social.acceptFriendRequest("alice", requestId);
        expect(selfAccept.friends).toEqual([]);
        expect(selfAccept.outgoingRequests).toHaveLength(1);
        const selfIgnore = yield* social.ignoreFriendRequest("alice", requestId);
        expect(selfIgnore.outgoingRequests).toHaveLength(1);

        // A repeat request is a conflict.
        const repeat = yield* Effect.flip(social.sendFriendRequest("alice", bob.profile.friendCode));
        expect(repeat).toMatchObject({ _tag: "SocialConflict", error: "Friend request already pending" });

        const accepted = yield* social.acceptFriendRequest("bob", requestId);
        expect(accepted.incomingRequests).toEqual([]);
        expect(accepted.friends).toEqual([{ userId: "alice", displayName: "Alice", since: expect.any(Number) }]);
        expect((yield* social.overview("alice")).friends.map((friend) => friend.userId)).toEqual(["bob"]);

        const again = yield* Effect.flip(social.sendFriendRequest("bob", (yield* social.overview("alice")).profile.friendCode));
        expect(again).toMatchObject({ _tag: "SocialConflict", error: "Already friends" });

        const removed = yield* social.removeFriend("alice", "bob");
        expect(removed.friends).toEqual([]);
        expect((yield* social.overview("bob")).friends).toEqual([]);
      }),
    ));

  test("requesting someone who already asked you accepts their request", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const alice = yield* social.ensureProfile("alice");
        const bob = yield* social.ensureProfile("bob");
        yield* social.sendFriendRequest("alice", bob.friendCode);
        const result = yield* social.sendFriendRequest("bob", alice.friendCode);
        expect(result.friends.map((friend) => friend.userId)).toEqual(["alice"]);
        expect(result.incomingRequests).toEqual([]);
      }),
    ));

  test("ignoring deletes the request", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const bob = yield* social.ensureProfile("bob");
        const sent = yield* social.sendFriendRequest("alice", bob.friendCode);
        const ignored = yield* social.ignoreFriendRequest("bob", sent.outgoingRequests[0]!.id);
        expect(ignored.incomingRequests).toEqual([]);
        expect((yield* social.overview("alice")).outgoingRequests).toEqual([]);
        // Ignored requests can be sent again.
        const resent = yield* social.sendFriendRequest("alice", bob.friendCode);
        expect(resent.outgoingRequests).toHaveLength(1);
      }),
    ));

  test("friend request input errors", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const alice = yield* social.ensureProfile("alice");
        expect(yield* Effect.flip(social.sendFriendRequest("alice", "--"))).toMatchObject({
          _tag: "BadRequest",
          error: "Invalid friend code",
        });
        expect(yield* Effect.flip(social.sendFriendRequest("alice", "ZZZZZZ"))).toMatchObject({
          _tag: "NotFound",
          error: "Friend code not found",
        });
        expect(yield* Effect.flip(social.sendFriendRequest("alice", alice.friendCode))).toMatchObject({
          _tag: "BadRequest",
          error: "You cannot add yourself",
        });
      }),
    ));

  test("daily summaries total friends' entries for the day", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const sync = yield* SyncRepository;
        yield* social.updateProfile("alice", "Alice");
        yield* social.updateProfile("bob", "Bob");
        yield* social.updateProfile("carol", "Carol");
        yield* befriend(social, "alice", "bob");
        yield* befriend(social, "alice", "carol");
        yield* social.ensureProfile("stranger");

        yield* sync.push("bob", {
          foodEntries: [
            { id: "b1", updatedAt: 100, data: entry({ portion: 1.5, nutrition: { calories: 101, protein: 3.3, carbs: 10, fat: 0.5 } }) },
            { id: "b2", updatedAt: 300, data: entry({ nutrition: { calories: 50.4 } }) },
            { id: "b3", updatedAt: 400, deletedAt: 400, data: entry({ nutrition: { calories: 999 } }) },
            { id: "b4", updatedAt: 500, data: entry({ dateKey: "2026-10-20", nutrition: { calories: 999 } }) },
          ],
          recipes: [],
          settings: { id: "settings", updatedAt: 1, data: settings },
        });
        yield* sync.push("stranger", {
          foodEntries: [{ id: "s1", updatedAt: 1, data: entry({ nutrition: { calories: 5000 } }) }],
          recipes: [],
        });

        const { summaries } = yield* social.dailySummaries("alice", "2026-10-21");
        expect(summaries).toEqual([
          {
            userId: "bob",
            displayName: "Bob",
            dateKey: "2026-10-21",
            calories: 202,
            protein: 5,
            carbs: 15,
            fat: 1,
            calorieGoal: 2000,
            lastUpdatedAt: 300,
          },
          {
            userId: "carol",
            displayName: "Carol",
            dateKey: "2026-10-21",
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
            calorieGoal: null,
            lastUpdatedAt: null,
          },
        ]);
        expect(Schema.encodeUnknownSync(FriendDailySummariesResponse)({ summaries })).toEqual({ summaries });
        expect(yield* social.dailySummaries("stranger", "2026-10-21")).toEqual({ summaries: [] });
      }),
    ));

  test("friend day requires friendship and sorts entries", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const sync = yield* SyncRepository;
        yield* befriend(social, "alice", "bob");
        yield* social.ensureProfile("stranger");
        yield* sync.push("bob", {
          foodEntries: [
            { id: "e3", updatedAt: 3, data: entry({ meal: "dinner", nutrition: { calories: 10 } }) },
            { id: "e2", updatedAt: 2, data: entry({ meal: "breakfast", sortIndex: 1, nutrition: { calories: 20 } }) },
            { id: "e1", updatedAt: 1, data: entry({ meal: "breakfast", sortIndex: 0 }) },
          ],
          recipes: [],
          settings: { id: "settings", updatedAt: 1, data: settings },
        });

        const day = yield* social.friendDay("alice", "bob", "2026-10-21");
        expect(day.entries.map((row) => row.id)).toEqual(["e1", "e2", "e3"]);
        expect(day.entries[2]).toEqual({ id: "e3", updatedAt: 3, ...entry({ meal: "dinner", nutrition: { calories: 10 } }) });
        expect(day.summary).toMatchObject({ userId: "bob", displayName: DEFAULT_DISPLAY_NAME, calories: 30, lastUpdatedAt: 3 });
        expect(day.settings).toEqual(settings);
        expect(Schema.encodeUnknownSync(FriendDailyDayResponse)(day)).toEqual(day);

        expect(yield* Effect.flip(social.friendDay("alice", "stranger", "2026-10-21"))).toMatchObject({
          _tag: "NotFound",
          error: "Friend not found",
        });
      }),
    ));

  test("overview encodes with the wire schema", () =>
    run(
      Effect.gen(function* () {
        const social = yield* Social;
        const overview = yield* befriend(social, "alice", "bob");
        expect(Schema.encodeUnknownSync(SocialOverview)(overview)).toEqual(overview);
      }),
    ));
});

describe("social helpers", () => {
  test("summarizeDay treats invalid portions as 1 and rounds totals", () => {
    const rows = [
      { id: "a", updatedAt: new Date(5), data: entry({ portion: 0, nutrition: { calories: 10.4, protein: 0.4 } }) },
      { id: "b", updatedAt: new Date(2), data: entry({ portion: 2, nutrition: { calories: 0.3, protein: 0.4 } }) },
    ];
    expect(summarizeDay({ userId: "u", displayName: "U", dateKey: "2026-10-21" }, undefined, rows)).toEqual({
      userId: "u",
      displayName: "U",
      dateKey: "2026-10-21",
      calories: 11,
      protein: 1,
      carbs: 0,
      fat: 0,
      calorieGoal: null,
      lastUpdatedAt: 5,
    });
  });

  test("normalizeFriendCode strips separators and uppercases", () => {
    expect(normalizeFriendCode(" ab-c 2d3 ")).toBe("ABC2D3");
  });

  test("payload schemas are strict and trim like backend/", () => {
    const strict = { onExcessProperty: "error" } as const;
    expect(Schema.decodeUnknownSync(ProfilePayload)({ displayName: "  Ada  " }, strict)).toEqual({ displayName: "Ada" });
    expect(Schema.decodeUnknownSync(ProfilePayload)({}, strict)).toEqual({});
    expect(() => Schema.decodeUnknownSync(ProfilePayload)({ displayName: "   " }, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(ProfilePayload)({ displayName: "x".repeat(81) }, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(ProfilePayload)({ name: "Ada" }, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(ProfilePayload)(null, strict)).toThrow();
    expect(() => Schema.decodeUnknownSync(FriendCodePayload)({ friendCode: "" }, strict)).toThrow();
    expect(Schema.decodeUnknownSync(DateKey)(" 2026-10-21 ")).toBe("2026-10-21");
    expect(() => Schema.decodeUnknownSync(DateKey)("2026-1-21")).toThrow();
    expect(() => Schema.decodeUnknownSync(DateKey)(undefined)).toThrow();
  });
});
