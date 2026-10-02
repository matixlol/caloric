import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  FoodEntrySchema,
  RecipeSchema,
  UserSettingsSchema,
} from "@caloric/data-model";
import {
  applyChanges,
  bootstrap,
  createDemo,
  dateKey,
  macroGoals,
  makeEntry,
  orderedDay,
  portionFromDrag,
  pushChanges,
  reorderEntries,
  recipeFood,
  shiftDate,
  totals,
} from "./model";
import { demoFriendDay } from "./friends";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("journal data", () => {
  test("portion drag has the native dead zone and weighted whole-number targets", () => {
    expect(portionFromDrag(100)).toBeNull();
    expect(portionFromDrag(-53.99)).toBeNull();
    expect(portionFromDrag(-54)).toBe(0.25);
    expect(portionFromDrag(-66.5)).toBe(0.25); // Midpoint ties go to the smaller portion.
    expect(portionFromDrag(-66.51)).toBe(0.5);
    expect(portionFromDrag(-122.75)).toBe(0.75); // A uniform 25px slider would already show 1×.
    expect(portionFromDrag(-122.76)).toBe(1);
    expect(portionFromDrag(-229)).toBe(1.75);
    expect(portionFromDrag(-266.5)).toBe(2);
    expect(portionFromDrag(-372.75)).toBe(2.75);
    expect(portionFromDrag(-372.76)).toBe(3);
    expect(portionFromDrag(-1000)).toBe(3);
  });
  test("scales asymmetric portions and preserves missing nutrition", () => {
    expect(
      totals([
        { portion: 0.5, nutrition: { calories: 210, protein: 13, fiber: 8 } },
        { portion: 2.25, nutrition: { calories: 80, carbs: 7 } },
        { portion: 3 },
      ]),
    ).toEqual({ calories: 285, protein: 6.5, fiber: 4, carbs: 15.75 });
    expect(totals([{ portion: 1 }])).toEqual({});
  });
  test("derives fat goals with 9 kcal/g, other macros with 4", () => {
    expect(
      macroGoals({
        calorieGoal: 2370,
        macroProteinPct: 31,
        macroCarbsPct: 42,
        macroFatPct: 27,
      }),
    ).toEqual({ protein: 184, carbs: 249, fat: 71 });
  });
  test("handles local calendar month, year, leap-day and DST boundaries", () => {
    expect(shiftDate("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDate("2026-03-28", 1)).toBe("2026-03-29");
    expect(shiftDate("2026-10-25", 1)).toBe("2026-10-26");
    expect(dateKey(new Date(2026, 9, 2, 0, 1))).toBe("2026-10-02");
  });
  test("sorts by persisted order, not insertion or creation time", () => {
    const snapshot = createDemo("2026-10-02");
    const day = orderedDay(snapshot, "2026-10-02");
    day[0].data.sortIndex = 999;
    expect(orderedDay(snapshot, "2026-10-02").at(-1)?.data.foodName).toBe(
      "Greek yogurt",
    );
    expect(orderedDay(snapshot, "2026-10-03")).toEqual([]);
  });
  test("reorders in both directions and across empty meals without changing food data", () => {
    const snapshot = createDemo("2026-10-02");
    const rows = orderedDay(snapshot, "2026-10-02");
    const breakfast = rows.filter((row) => row.data.meal === "breakfast");
    const move = (id: string, meal: "breakfast" | "dinner", index: number) => {
      const changed = reorderEntries(rows, id, meal, index);
      const next = orderedDay(
        applyChanges(snapshot, { entries: changed }),
        "2026-10-02",
      );
      for (const row of next) {
        const { meal: _, sortIndex: __, ...food } = row.data;
        const {
          meal: ___,
          sortIndex: ____,
          ...original
        } = rows.find((entry) => entry.id === row.id)!.data;
        expect(food).toEqual(original);
      }
      expect(next.map((row) => row.data.sortIndex)).toEqual(
        next.map((_, index) => index),
      );
      expect(new Set(next.map((row) => row.id)).size).toBe(rows.length);
      return next
        .filter((row) => row.data.meal === meal)
        .map((row) => row.data.foodName);
    };
    expect(breakfast.map((row) => row.data.foodName)).toEqual([
      "Greek yogurt",
      "Blueberries",
      "Honey & oat granola",
      "Flat white",
    ]);
    expect(move(breakfast[0].id, "breakfast", 2)).toEqual([
      "Blueberries",
      "Honey & oat granola",
      "Greek yogurt",
      "Flat white",
    ]);
    expect(move(breakfast[3].id, "breakfast", 1)).toEqual([
      "Greek yogurt",
      "Flat white",
      "Blueberries",
      "Honey & oat granola",
    ]);
    expect(move(breakfast[1].id, "dinner", 0)).toEqual(["Blueberries"]);
    expect(reorderEntries(rows, breakfast[0].id, "breakfast", -1)).toEqual([]);
    expect(reorderEntries(rows, breakfast[3].id, "breakfast", 999)).toEqual([]);
    expect(
      rows.filter((row) => row.data.meal === "breakfast").map((row) => row.id),
    ).toEqual(breakfast.map((row) => row.id));
  });
  test("edits, deletes, restores and replaces without duplicating rows or mutating inputs", () => {
    const original = createDemo("2026-10-02");
    const entry = original.entries[0];
    const changed = {
      ...entry,
      updatedAt: 42,
      data: { ...entry.data, portion: 1.75, meal: "dinner" as const },
    };
    const next = applyChanges(original, { entries: [changed] });
    expect(next.entries.filter((row) => row.id === entry.id)).toEqual([
      changed,
    ]);
    expect(original.entries[0].data.portion).toBe(1);
    const removed = applyChanges(next, {
      entries: [{ ...changed, deletedAt: 43 }],
    });
    expect(removed.entries.some((row) => row.id === entry.id)).toBe(false);
    const restored = applyChanges(removed, { entries: [changed] });
    expect(restored.entries.filter((row) => row.id === entry.id)).toHaveLength(
      1,
    );
  });
  test("recipes keep nutrition per recipe, log portion scales it once", () => {
    const snapshot = createDemo("2026-10-02");
    const recipe = snapshot.recipes[0];
    recipe.data.items[0].portion = 1.5;
    const food = recipeFood(recipe);
    expect(food.nutrition?.calories).toBe(417); // 120 × 1.5 + 57 + 180
    const entry = makeEntry(food, "dinner", "2026-10-03", 0.75, snapshot);
    expect(totals([entry.data]).calories).toBe(312.75);
    expect(entry.data.dateKey).toBe("2026-10-03");
    expect(entry.data.sortIndex).toBe(0);
    expect(() =>
      makeEntry(food, "dinner", "2026-10-03", 0, snapshot),
    ).toThrow();
  });
});

describe("database seed fixtures", () => {
  test("fixtures satisfy native contracts and friend summaries equal their entries", () => {
    const snapshot = createDemo("2026-10-02");
    expect(snapshot.entries).toHaveLength(82);
    expect(
      totals(orderedDay(snapshot, "2026-10-02").map((row) => row.data))
        .calories,
    ).toBe(1256);
    for (const row of snapshot.entries)
      expect(FoodEntrySchema.safeParse(row.data).success).toBe(true);
    for (const row of snapshot.recipes)
      expect(RecipeSchema.safeParse(row.data).success).toBe(true);
    expect(UserSettingsSchema.safeParse(snapshot.settings).success).toBe(true);
    const friend = demoFriendDay("demo_alex", "2026-10-02");
    expect(friend.summary.calories).toBe(1359);
    expect(totals(friend.entries).calories).toBe(1359);
  });
});

describe("live API contracts (mock transport, no database)", () => {
  test("bootstrap decodes food entries and recipes separately", async () => {
    const snapshot = createDemo("2026-10-02");
    const payload = {
      foodEntries: snapshot.entries.slice(0, 2),
      recipes: snapshot.recipes.slice(0, 1),
      settings: { id: "settings", data: snapshot.settings, updatedAt: 123 },
    };
    globalThis.fetch = mock(async () =>
      Response.json(payload),
    ) as unknown as typeof fetch;
    const result = await bootstrap();
    expect(result.entries.map((row) => row.data.foodName)).toEqual([
      "Greek yogurt",
      "Blueberries",
    ]);
    expect(result.recipes[0].data.name).toBe("My breakfast bowl");
    globalThis.fetch = mock(async () =>
      Response.json({
        ...payload,
        foodEntries: payload.recipes,
        recipes: payload.foodEntries,
      }),
    ) as unknown as typeof fetch;
    await expect(bootstrap()).rejects.toThrow();
  });
  test("writes tombstones and rejects an unaccepted stale write", async () => {
    const entry = createDemo("2026-10-02").entries[0];
    let sent: any;
    globalThis.fetch = mock(async (path, options) => {
      expect(path).toBe("/sync/push");
      expect(options?.credentials).toBe("same-origin");
      sent = JSON.parse(String(options?.body));
      return Response.json({
        acceptedFoodEntryIds: [entry.id],
        acceptedRecipeIds: [],
        acceptedSettings: false,
      });
    }) as unknown as typeof fetch;
    await pushChanges({ entries: [{ ...entry, deletedAt: 567 }] });
    expect(sent.foodEntries[0].deletedAt).toBe(567);
    expect(sent.foodEntries[0].data).toEqual(entry.data);
    globalThis.fetch = mock(async () =>
      Response.json({
        acceptedFoodEntryIds: [],
        acceptedRecipeIds: [],
        acceptedSettings: false,
      }),
    ) as unknown as typeof fetch;
    await expect(pushChanges({ entries: [entry] })).rejects.toThrow(
      "newer change",
    );
  });
});
