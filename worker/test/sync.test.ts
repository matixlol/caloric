import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SyncRepository } from "../src/sync/SyncRepository.ts";
import { TestDb } from "./TestDb.ts";

const run = <A, E>(effect: Effect.Effect<A, E, SyncRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SyncRepository.layer.pipe(Layer.provide(TestDb)))));

const entry = (foodName: string) => ({
  meal: "lunch" as const,
  foodName,
  portion: 1,
  createdAt: 1,
  dateKey: "2026-10-21",
  sortIndex: 0,
});

describe("SyncRepository", () => {
  test("applies newer writes and rejects stale ones", () =>
    run(
      Effect.gen(function* () {
        const sync = yield* SyncRepository;
        const first = yield* sync.push("u1", { foodEntries: [{ id: "e1", updatedAt: 10, data: entry("Apple") }], recipes: [] });
        const stale = yield* sync.push("u1", { foodEntries: [{ id: "e1", updatedAt: 9, data: entry("Old") }], recipes: [] });
        const same = yield* sync.push("u1", { foodEntries: [{ id: "e1", updatedAt: 10, data: entry("Pear") }], recipes: [] });
        const snapshot = yield* sync.bootstrap("u1");

        expect(first.acceptedFoodEntryIds).toEqual(["e1"]);
        expect(stale.acceptedFoodEntryIds).toEqual([]);
        expect(same.acceptedFoodEntryIds).toEqual(["e1"]);
        expect(snapshot.foodEntries).toEqual([{ id: "e1", data: entry("Pear"), updatedAt: 10 }]);
        expect(snapshot.settings).toBeNull();
      }),
    ));

  test("hides deleted rows and scopes rows to their user", () =>
    run(
      Effect.gen(function* () {
        const sync = yield* SyncRepository;
        yield* sync.push("u1", {
          foodEntries: [
            { id: "keep", updatedAt: 1, data: entry("Keep") },
            { id: "gone", updatedAt: 1, deletedAt: 1, data: entry("Gone") },
          ],
          recipes: [],
          settings: { id: "settings", updatedAt: 1, data: { calorieGoal: 2000, macroProteinPct: 30, macroCarbsPct: 40, macroFatPct: 30 } },
        });
        const own = yield* sync.bootstrap("u1");
        const other = yield* sync.bootstrap("u2");

        expect(own.foodEntries.map((row) => row.id)).toEqual(["keep"]);
        expect(own.settings?.data.calorieGoal).toBe(2000);
        expect(other.foodEntries).toEqual([]);
      }),
    ));

  test("pushes many rows across statements and keeps the newest copy of a repeated id", () =>
    run(
      Effect.gen(function* () {
        const sync = yield* SyncRepository;
        const rows = Array.from({ length: 100 }, (_, index) => ({ id: `e${index}`, updatedAt: 10, data: entry(`Food ${index}`) }));
        const first = yield* sync.push("u1", { foodEntries: rows, recipes: [] });
        expect(first.acceptedFoodEntryIds.length).toBe(100);

        const second = yield* sync.push("u1", {
          foodEntries: [
            { id: "e1", updatedAt: 20, data: entry("Newer") },
            { id: "e1", updatedAt: 15, data: entry("Older duplicate") },
            { id: "e2", updatedAt: 5, data: entry("Stale") },
          ],
          recipes: [],
        });
        expect(second.acceptedFoodEntryIds).toEqual(["e1"]);

        const snapshot = yield* sync.bootstrap("u1");
        const byId = new Map(snapshot.foodEntries.map((row) => [row.id, row]));
        expect(snapshot.foodEntries.length).toBe(100);
        expect(byId.get("e1")?.data.foodName).toBe("Newer");
        expect(byId.get("e2")?.data.foodName).toBe("Food 2");
      }),
    ));
});
